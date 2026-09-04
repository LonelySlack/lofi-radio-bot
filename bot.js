import './env.js';           // must come first — see env.js
import { Client, GatewayIntentBits, EmbedBuilder, ActivityType, SlashCommandBuilder, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, NoSubscriberBehavior, StreamType } from '@discordjs/voice';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { Transform } from 'stream';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { BUILTIN, findStation, stationFromUrl, searchStations, resolveStationId, youtubeLiveTitle, youtubeManifestUrl, fetchIcyTitle, ytProxy } from './stations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

/* ============================ logging ============================ */
// Stamp every line with local time. Diagnosing a 24/7 bot means lining its log
// up against Discord message times and station outages, and an untimed log makes
// that pure guesswork. 'sv-SE' is the shortest route to a sortable local
// YYYY-MM-DD HH:MM:SS with no locale surprises.
{
  const stamp = () => new Date().toLocaleString('sv-SE', { hour12: false });
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => orig(stamp(), ...args);
  }
}

const FFMPEG = process.env.FFMPEG_PATH || '/home/lonelyslack/bin/ffmpeg';
const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = process.env.PREFIX || 'lofi';
const DEFAULT_STATION = process.env.DEFAULT_STATION || 'lofigirl';
const FALLBACK_STATION = process.env.FALLBACK_STATION || 'somafm-fluid';
const RECYCLE_MS = (parseFloat(process.env.STREAM_RECYCLE_HOURS ?? '12') || 0) * 3600 * 1000;
const PAUSE_WHEN_EMPTY = /^(1|true|yes)$/i.test(process.env.PAUSE_WHEN_EMPTY || '');
const ADMIN_IDS = new Set((process.env.ADMIN_ID || '').split(',').map(s => s.trim()).filter(Boolean));
if (!TOKEN) { console.error('DISCORD_TOKEN required'); process.exit(1); }

// A radio stream never "ends", so silence means something broke. If no audio
// bytes reach us for this long, tear the chain down and rebuild it.
const STALL_MS = 25000;
const WATCHDOG_MS = 5000;
// Consecutive failures before we give up on the primary and drop to the fallback
// station, so the channel keeps playing something instead of going silent.
const FAILS_BEFORE_FALLBACK = 4;
// Once a stream has run this long without stalling, treat it as healthy and
// forget the earlier failures (otherwise a bad night poisons the counter forever).
const HEALTHY_AFTER_MS = 60000;
const NP_EDIT_THROTTLE_MS = 5000;
// How long the resume sweep tolerates a connection that is neither Ready nor
// Destroyed before it tears it down. A wedged adapter looks "alive" forever, so
// without this the sweep skips the exact case it exists to catch.
const SWEEP_STUCK_MS = 90000;
// Astro/iHeart endpoints answer with a 302 to an edge URL carrying a very short
// lived token (…?rj-ttl=5&rj-tok=…). ffmpeg follows that correctly on a fresh
// spawn, but its own -reconnect retries the *expired* token URL and gets
// nowhere, so the stream simply ends. Re-spawning against the original URL
// mints a fresh token, so for these a clean end is routine, not a fault.
const TOKEN_REDIRECT_RE = /(^|\.)(revma\.com|streamtheworld\.com)$/i;
// …but only once we've actually had audio for a while. A station that EOFs
// immediately on every attempt is broken, not renewing, and must still fall back.
const TOKEN_RENEW_GRACE_MS = 20000;
function isTokenRedirect(station) {
  if (!station?.url) return false;
  try { return TOKEN_REDIRECT_RE.test(new URL(station.url).hostname); } catch { return false; }
}

/* ============================ persistence ============================ */
// What each guild was listening to, so a restart (deploy, crash, nightly recycle)
// puts the bot back in the same channel on the same station without anyone asking.
const STATE_FILE = join(__dirname, 'state.json');
let saved = {};
try { if (existsSync(STATE_FILE)) saved = JSON.parse(readFileSync(STATE_FILE, 'utf8')) || {}; }
catch (e) { console.error(`[state] unreadable, starting fresh: ${e.message}`); }
let saveTimer = null;
function saveState() {
  // Debounced + atomic (write-then-rename) so a crash mid-write can't leave a
  // truncated state.json that we'd fail to parse on the next boot.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = {};
    for (const [gid, q] of stations) {
      if (q.channelId && q.station) out[gid] = { channelId: q.channelId, textChannelId: q.textChannel?.id ?? null, stationId: q.station.id === 'custom' ? q.station.url : q.station.id, volume: q.volume };
    }
    try { writeFileSync(STATE_FILE + '.tmp', JSON.stringify(out, null, 2)); renameSync(STATE_FILE + '.tmp', STATE_FILE); }
    catch (e) { console.error(`[state] save failed: ${e.message}`); }
  }, 1000);
}

/* ============================ per-guild state ============================ */
const stations = new Map();
function getQ(guildId) {
  if (!stations.has(guildId)) {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    // A live stream going Idle means the pipe closed — always a fault, never a
    // normal end-of-track. Rebuild instead of sitting silent.
    player.on(AudioPlayerStatus.Idle, () => onStreamDown(guildId, 'player idle'));
    player.on('error', (e) => onStreamDown(guildId, `player error: ${e.message}`));
    stations.set(guildId, {
      station: null, player, connection: null, channelId: null, textChannel: null,
      procs: [], volume: 1, streaming: false, startedAt: 0, lastData: 0, fails: 0,
      nowPlaying: null, npMessage: null, npEditedAt: 0, npPending: null, restartTimer: null,
      recycleTimer: null, icyTimer: null, ffErr: '', notReadySince: 0, sweepNotReadySince: 0,
      starting: false, stopped: false, uiGenre: null, uiPage: 0,
    });
  }
  return stations.get(guildId);
}

/* ============================ WARP rotation ============================ */
// Lifted from the music bot: YouTube periodically bot-flags WARP's Cloudflare
// egress IP, and retrying the same IP keeps failing. Rotating WARP lands a fresh
// one. Serialized so a burst of failures triggers ONE rotation, not a stampede.
let _warpRotating = null;
function rotateWarp() {
  if (_warpRotating) return _warpRotating;
  _warpRotating = (async () => {
    try {
      await execFileAsync('warp-cli', ['--accept-tos', 'disconnect'], { timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      await execFileAsync('warp-cli', ['--accept-tos', 'connect'], { timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 5000));
      console.log('[warp] rotated egress IP after YouTube bot-check');
    } catch (e) { console.error('[warp] rotate failed:', e.message); }
  })().finally(() => { _warpRotating = null; });
  return _warpRotating;
}
const isBotCheck = (msg) => /\b429\b|Too Many Requests|not a bot|Sign in to confirm/i.test(msg || '');

/* ============================ the stream chain ============================ */
// Counts bytes as they pass so the watchdog can tell "playing" from "silently
// dead". A Transform (not a 'data' listener) because attaching a listener before
// the resource pipes it would flip the stream to flowing mode and drop audio.
function meter(q) {
  return new Transform({ transform(chunk, _enc, cb) { q.lastData = Date.now(); cb(null, chunk); } });
}
// ffmpeg tail: whatever comes in, out comes 48kHz stereo Ogg/Opus, which is
// exactly what Discord wants (no re-encode inside @discordjs/voice).
function ffTail(q) {
  const af = q.volume !== 1 ? ['-af', `volume=${q.volume.toFixed(2)}`] : [];
  return [...af, '-vn', '-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-b:a', '96k', '-vbr', 'on', '-application', 'audio', '-f', 'ogg', 'pipe:1'];
}
// Keep the last few stderr lines so a crash can say *why* instead of just
// "ffmpeg exit 1". (Measured: ffmpeg 8.x prints nothing useful about ICY titles
// at -loglevel info even across track changes — hence the poller below, not
// stderr scraping.)
function watchStderr(q, proc) {
  proc.stderr.on('data', d => { q.ffErr = ((q.ffErr || '') + d).slice(-1200); });
}

/* ---- now-playing polling ---- */
// Icecast/SHOUTcast publish the current track in-band, but ffmpeg won't surface
// it to us, so we ask the station ourselves on a timer. ~16KB per poll.
const ICY_POLL_MS = 30000;
function stopIcyPoll(q) { if (q.icyTimer) { clearInterval(q.icyTimer); q.icyTimer = null; } }
function startIcyPoll(guildId) {
  const q = getQ(guildId);
  stopIcyPoll(q);
  if (!q.station || q.station.type !== 'icecast') return;
  let misses = 0;
  const tick = async () => {
    if (q.stopped || !q.streaming) return;
    const station = q.station;
    const title = await fetchIcyTitle(station.url).catch(() => null);
    if (q.station !== station) return;        // station changed while we were asking
    if (title) { misses = 0; setNowPlaying(guildId, title); }
    // Three empty answers in a row means this station simply doesn't publish
    // titles — stop knocking on its door every 30 seconds.
    else if (++misses >= 3) { console.log(`[${guildId}] no ICY titles from ${station.name} — polling off`); stopIcyPoll(q); }
  };
  tick();                                      // read once immediately so `np` is useful right away
  q.icyTimer = setInterval(tick, ICY_POLL_MS);
}

// Build the process chain for a station and hand @discordjs/voice the Opus stream.
//   icecast → ffmpeg reads the HTTP stream directly (with its own reconnect logic)
//   youtube → yt-dlp resolves the HLS manifest, ffmpeg streams it directly.
//             Both hops must exit through the same proxy: the manifest URL is
//             IP-locked to whatever address requested it, so resolving via WARP
//             and then fetching segments direct earns a 403 on every segment.
//             ffmpeg propagates -http_proxy from the manifest to its child
//             segment requests (hls.c save_avio_options whitelists it), so one
//             flag covers both. The manifest expires after a few hours; ffmpeg
//             then fails, the watchdog fires, and the retry re-resolves.
async function buildChain(q, guildId, station) {
  const procs = [];
  let ff;
  if (station.type === 'youtube') {
    // proxy is whatever actually resolved the manifest — WARP when the bridge is
    // up, '' when it isn't. ffmpeg has to use that same value or the segments
    // come back 403, so it is threaded through rather than recomputed.
    let manifest, proxy;
    try {
      ({ manifest, proxy } = await youtubeManifestUrl(station.url));
    } catch (e) {
      const err = String(e.stderr || e.message || e);
      // A bot-check means the WARP exit IP is flagged; rotate so the retry that
      // follows gets a fresh one. Pointless when we resolved direct — there is
      // no exit to rotate — so only rotate if the bridge was actually in play.
      if (await ytProxy().catch(() => '') && isBotCheck(err)) {
        console.warn(`[${guildId}] yt-dlp bot-check — rotating WARP`); rotateWarp();
      }
      throw new Error(`yt-dlp resolve: ${err.trim().split('\n').pop().slice(0, 200)}`);
    }
    ff = spawn(FFMPEG, [
      '-loglevel', 'info',
      ...(proxy ? ['-http_proxy', proxy] : []),
      '-reconnect', '1', '-reconnect_streamed', '1',
      '-reconnect_on_network_error', '1', '-reconnect_on_http_error', '4xx,5xx',
      '-reconnect_delay_max', '5',
      '-rw_timeout', '15000000',
      '-i', manifest, ...ffTail(q),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    // ffmpeg's own recovery for the ordinary case (a blip, a 5xx, a CDN hiccup).
    // The watchdog above is the backstop for when even this gives up.
    //
    // Token-redirect stations are the exception: ffmpeg would retry the expired
    // edge URL and burn -reconnect_delay_max seconds getting nowhere, delaying
    // the honest failure. Let it exit promptly instead — onStreamDown re-spawns
    // against the original URL, which is the only thing that actually recovers.
    const reconnect = isTokenRedirect(station) ? [] : [
      '-reconnect', '1', '-reconnect_streamed', '1',
      '-reconnect_on_network_error', '1', '-reconnect_on_http_error', '4xx,5xx',
      '-reconnect_delay_max', '10',
    ];
    ff = spawn(FFMPEG, [
      '-loglevel', 'info',
      ...reconnect,
      '-rw_timeout', '20000000',           // 20s in microseconds — don't hang on a dead socket
      '-i', station.url, ...ffTail(q),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  q.ffErr = '';
  watchStderr(q, ff);
  ff.stdout.on('error', () => {});
  ff.on('error', (e) => onStreamDown(guildId, `ffmpeg spawn: ${e.message}`));
  ff.on('close', (code) => {
    if (code === 0 || code === null) return;
    const tail = (q.ffErr || '').trim().split('\n').slice(-2).join(' | ').slice(0, 200);
    onStreamDown(guildId, `ffmpeg exit ${code}${tail ? ': ' + tail : ''}`);
  });
  procs.push(ff);
  q.procs = procs;
  return createAudioResource(ff.stdout.pipe(meter(q)), { inputType: StreamType.OggOpus });
}

function killChain(q) {
  for (const p of q.procs) { try { p.kill('SIGKILL'); } catch {} }
  q.procs = [];
}

async function startStream(guildId, station) {
  const q = getQ(guildId);
  if (q.starting) return;
  q.starting = true;
  try {
    clearTimeout(q.restartTimer); q.restartTimer = null;
    killChain(q);
    q.station = station;
    q.stopped = false;
    q.nowPlaying = null;
    console.log(`[${guildId}] 📻 ${station.name} (${station.type})`);
    // Wait for the voice handshake — NoSubscriberBehavior.Play throws audio away
    // while the connection isn't Ready, so starting early burns the first seconds.
    const ready = await awaitVoiceReady(q, guildId);
    if (q.stopped) return;
    if (!ready) {
      // Playing into a connection that never reached Ready is worse than not
      // playing at all: bytes flow, q.lastData keeps ticking, the stall watchdog
      // stays green — and the channel is silent while every health signal reads
      // OK. That is exactly how a wedged adapter went unnoticed for 13 hours.
      // Refuse to start, and let the retry ladder keep working on voice instead.
      q.starting = false;
      onStreamDown(guildId, 'voice never reached Ready', false, true);
      return;
    }
    let resource;
    try {
      resource = await buildChain(q, guildId, station);
    } catch (e) {
      // onStreamDown bails while a start is in flight (it guards on q.starting),
      // and the stall watchdog skips guilds that never reached q.streaming - so
      // without clearing this first a failed resolve would schedule no retry at
      // all and the guild would sit silent. The finally below re-clears it.
      q.starting = false;
      onStreamDown(guildId, e.message);
      return;
    }
    q.streaming = true;
    q.startedAt = Date.now();
    q.lastData = Date.now();
    q.player.play(resource);
    // YouTube gives us no in-band metadata, so the video title is the best we
    // have; Icecast stations get polled for the live track name instead.
    if (station.type === 'youtube') {
      // Switching from an Icecast station leaves its poller running, and `tick`
      // re-reads q.station each time - so it would start polling the YouTube
      // watch page for ICY titles until it gave up. Stop it explicitly.
      stopIcyPoll(q);
      youtubeLiveTitle(station.url).then(t => { if (t && q.station === station) setNowPlaying(guildId, t); }).catch(() => {});
    } else {
      startIcyPoll(guildId);
    }
    if (RECYCLE_MS > 0) {
      clearTimeout(q.recycleTimer);
      q.recycleTimer = setTimeout(() => { console.log(`[${guildId}] ♻ scheduled stream recycle`); onStreamDown(guildId, 'scheduled recycle', true); }, RECYCLE_MS);
    }
    showNowPlaying(q);
    saveState();
  } finally { q.starting = false; }
}

function stopStream(guildId, { keepConnection = true } = {}) {
  const q = stations.get(guildId);
  if (!q) return;
  q.stopped = true; q.streaming = false;
  clearTimeout(q.restartTimer); q.restartTimer = null;
  clearTimeout(q.recycleTimer); q.recycleTimer = null;
  clearTimeout(q.npPending); q.npPending = null;
  stopIcyPoll(q);
  killChain(q);
  try { q.player.stop(true); } catch {}
  if (!keepConnection) { try { q.connection?.destroy(); } catch {} q.connection = null; }
}

// Single funnel for every way a stream can die. Backs off, and after enough
// consecutive failures switches to the fallback station rather than going quiet.
function onStreamDown(guildId, reason, immediate = false, voiceFault = false) {
  const q = stations.get(guildId);
  if (!q || q.stopped || q.starting || !q.station) return;
  if (q.restartTimer) return;                 // a rebuild is already queued
  q.streaming = false;
  killChain(q);

  // An edge token expiring on a station that had been playing happily is routine
  // housekeeping, not a failure — re-spawning against the original URL mints a
  // new one. Charging it a strike would march every Astro station to the
  // fallback within a few minutes, which is precisely what used to happen.
  const tokenRenewal = !voiceFault
    && Date.now() - q.startedAt > TOKEN_RENEW_GRACE_MS
    && isTokenRedirect(q.station)
    && /player idle|ffmpeg exit/.test(reason);

  if (tokenRenewal) {
    // Reaching here proves the stream played for longer than the grace period,
    // so the station is demonstrably working: clear the counter. Without this a
    // renewal left q.fails untouched, and the amnesty below could never help
    // either — it wants HEALTHY_AFTER_MS of *continuous* play, and these edges
    // hand out tokens that can expire in under 30s. So transient EIOs from the
    // CDN accumulated across hours of healthy playback until the fourth one
    // tripped the fallback. That is exactly how HITZ ended up on SomaFM.
    q.fails = 0;
    console.log(`[${guildId}] ↻ ${q.station.name} edge token expired — re-resolving`);
  } else {
    // A stream that ran clean for a while and only then broke is fresh trouble,
    // so old failures shouldn't count against it. Voice faults are exempt: a
    // wedged connection cycles roughly every 90s, so the amnesty would fire on
    // every single pass and q.fails could never climb — no backoff, no ceiling.
    if (!voiceFault && Date.now() - q.startedAt > HEALTHY_AFTER_MS) q.fails = 0;
    q.fails++;
  }
  const delay = (immediate || tokenRenewal) ? 500 : Math.min(30000, 1000 * 2 ** Math.min(q.fails, 5));
  if (!tokenRenewal) console.error(`[${guildId}] ✖ stream down (${reason}) — retry #${q.fails} in ${Math.round(delay / 1000)}s`);

  q.restartTimer = setTimeout(async () => {
    q.restartTimer = null;
    let next = q.station;
    if (q.fails >= FAILS_BEFORE_FALLBACK) {
      if (voiceFault) {
        // The station is fine — the socket isn't. Swapping stations would just
        // play something else into the same dead connection, so rebuild voice
        // instead. startStream's awaitVoiceReady does this too; this is the
        // slower ladder catching the case where that keeps losing.
        console.warn(`[${guildId}] ⤵ ${q.fails} voice failures — rebuilding the voice connection`);
        q.fails = 0;
        await rebuildVoice(q, guildId).catch(() => false);
      } else {
        const fb = await resolveStationId(FALLBACK_STATION).catch(() => null);
        if (fb && fb.url !== q.station.url) {
          console.warn(`[${guildId}] ⤵ falling back to ${fb.name} after ${q.fails} failures`);
          q.textChannel?.send(`⚠️ **${q.station.name}** keeps dropping — switching to **${fb.name}** so the channel stays live.`).catch(() => {});
          next = fb; q.fails = 0;
        }
      }
    }
    startStream(guildId, next).catch(e => console.error(`[${guildId}] restart failed: ${e.message}`));
  }, delay);
}

// The backstop: ffmpeg can sit "alive" on a socket that will never send another
// byte, in which case nothing above fires. Silence is the only symptom, so we
// watch for silence.
setInterval(() => {
  for (const [guildId, q] of stations) {
    if (!q.streaming || q.stopped || q.starting) continue;
    if (Date.now() - q.lastData > STALL_MS) { onStreamDown(guildId, `no audio for ${Math.round((Date.now() - q.lastData) / 1000)}s`); continue; }
    // The nastier failure: audio flows fine but the voice connection never came
    // back to Ready, so every packet is thrown away and the channel is silent
    // while every other health signal looks green. Bytes moving is not proof
    // anyone can hear them.
    const st = q.connection?.state?.status;
    if (st !== VoiceConnectionStatus.Ready) {
      q.notReadySince ||= Date.now();
      if (Date.now() - q.notReadySince > 60000) { q.notReadySince = 0; onStreamDown(guildId, `voice not Ready for 60s (${st})`, false, true); }
    } else q.notReadySince = 0;
  }
}, WATCHDOG_MS);

/* ============================ health heartbeat ============================ */
// An external check can only see "is the process alive", and that stayed green
// through a 13-hour silent outage. Publish the things that actually decide
// whether anyone can hear us — voice status and time since the last audio byte —
// so bot-health-check.sh can assert on them instead of on liveness.
const HEALTH_FILE = join(__dirname, 'health.json');
function writeHealth() {
  const guilds = [...stations]
    .filter(([, q]) => !q.stopped && q.station)
    .map(([gid, q]) => ({
      guildId: gid,
      station: q.station?.name ?? null,
      voice: q.connection?.state?.status ?? 'none',
      streaming: !!q.streaming,
      silentMs: q.lastData ? Date.now() - q.lastData : null,
      fails: q.fails,
    }));
  // No guild on air is a legitimate idle state, not a fault.
  const ok = guilds.every(g => g.voice === VoiceConnectionStatus.Ready && g.streaming && g.silentMs !== null && g.silentMs < STALL_MS);
  try {
    writeFileSync(HEALTH_FILE + '.tmp', JSON.stringify({ ts: Date.now(), pid: process.pid, ok, guilds }, null, 2));
    renameSync(HEALTH_FILE + '.tmp', HEALTH_FILE);
  } catch (e) { /* a health file we can't write must never take the bot down */ }
}
setInterval(writeHealth, 15000);

/* ============================ now playing ============================ */
function setNowPlaying(guildId, title) {
  const q = stations.get(guildId);
  if (!q || !title || title === q.nowPlaying) return;
  q.nowPlaying = title;
  console.log(`[${guildId}] ♪ ${title}`);
  updatePresence();
  // Throttled: some Icecast servers push metadata far more often than the track
  // actually changes, and message edits are rate-limited per channel. A throttled
  // update isn't dropped — it's deferred, so the panel always lands on the title
  // that was current when the dust settled.
  if (Date.now() - q.npEditedAt > NP_EDIT_THROTTLE_MS) showNowPlaying(q);
  else if (!q.npPending) {
    q.npPending = setTimeout(() => { q.npPending = null; showNowPlaying(q); }, NP_EDIT_THROTTLE_MS);
  }
}
// One shared presence for the whole bot. With a single active guild we show the
// actual track; with several, a track from one server would misrepresent the rest.
function updatePresence() {
  const active = [...stations.values()].filter(q => q.streaming);
  if (!client.user) return;
  if (active.length === 1) {
    const q = active[0];
    client.user.setActivity((q.nowPlaying || q.station?.name || 'radio').slice(0, 128), { type: ActivityType.Listening });
  } else if (active.length > 1) {
    client.user.setActivity(`📻 ${active.length} servers`, { type: ActivityType.Listening });
  } else {
    client.user.setActivity(`${PREFIX} play — 24/7 radio`, { type: ActivityType.Listening });
  }
}
function npEmbed(q) {
  if (!q.station) return new EmbedBuilder().setColor(0x555555).setTitle('⏹️ Off air').setDescription(`Start it with \`${PREFIX} play\`.`);
  const e = new EmbedBuilder().setColor(q.streaming ? 0x9B59B6 : 0xE67E22)
    .setTitle(q.streaming ? '📻 On air' : '⏳ Reconnecting…')
    .setDescription(`**${q.station.name}**` + (q.nowPlaying ? `\n♪ ${q.nowPlaying}` : '\n*(this station sends no track info)*'));
  e.addFields(
    { name: 'Genre', value: q.station.genre || 'radio', inline: true },
    { name: 'Volume', value: `${Math.round(q.volume * 100)}%`, inline: true },
    { name: 'Uptime', value: q.streaming ? uptime(Date.now() - q.startedAt) : '—', inline: true },
  );
  e.setFooter({ text: `${q.station.id}${q.station.country ? ' · ' + q.station.country : ''} · ${PREFIX} stations` });
  return e;
}
function uptime(ms) {
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
// Genres in order of first appearance in the catalog, so the default vibe leads
// and the buttons never reshuffle under someone between renders. Discord allows
// 5 rows of 5 and the transport row takes one, leaving exactly 20 slots — which
// is what the catalog currently uses. The cap keeps the panel valid if it grows.
const GENRE_SLOTS = 20;
const GENRES = [...new Set(BUILTIN.map(s => s.genre))].slice(0, GENRE_SLOTS);

// Picker geometry. Discord gives 5 rows of 5: the transport row takes one and
// the nav row takes another, leaving 3 rows — 15 stations a page. The biggest
// genre (malaysia, 30) therefore needs 2 pages, and nothing is ever more than
// two taps away: genre, then station.
const PAGE_SIZE = 15;
const inGenre = (g) => BUILTIN.filter(s => s.genre === g);

function npRows(q) {
  const b = (id, emoji, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setEmoji(emoji).setStyle(style);
  const rows = [
    new ActionRowBuilder().addComponents(
      b('r_voldown', '🔉'), b('r_volup', '🔊'), b('r_random', '🔀'),
      b('r_refresh', '🔄'), b('r_stop', '⏹️', ButtonStyle.Danger)),
  ];

  // Station view: the stations of one genre, paged. Cycling through a genre one
  // tap at a time was fine for lofi's 4 but absurd for malaysia's 30 — HITZ was
  // two taps in, WAI FM Bidayuh was thirty.
  if (q.uiGenre) {
    const list = inGenre(q.uiGenre);
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    const page = Math.min(Math.max(q.uiPage || 0, 0), pages - 1);
    const slice = list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    for (let i = 0; i < slice.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(
        slice.slice(i, i + 5).map(st => new ButtonBuilder()
          .setCustomId(`r_s_${st.id}`)
          .setLabel(st.name.slice(0, 80))
          .setStyle(st.id === q.station?.id ? ButtonStyle.Success : ButtonStyle.Secondary))));
    }
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('r_pg_prev').setEmoji('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId('r_pg_next').setEmoji('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
      new ButtonBuilder().setCustomId('r_back').setLabel(`${q.uiGenre} ${page + 1}/${pages}`).setEmoji('↩').setStyle(ButtonStyle.Primary)));
    return rows;
  }

  // Genre view: one button per genre. A dropdown could only ever list 25
  // options, so 34 of the catalog — every Malaysian station among them — was
  // unreachable from the panel entirely.
  for (let i = 0; i < GENRES.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      GENRES.slice(i, i + 5).map(g => new ButtonBuilder()
        .setCustomId(`r_g_${g}`)
        .setLabel(inGenre(g).length > 1 ? `${g} (${inGenre(g).length})` : g)
        .setStyle(g === q.station?.genre ? ButtonStyle.Primary : ButtonStyle.Secondary))));
  }
  return rows;
}
async function showNowPlaying(q, { relocate = false } = {}) {
  if (!q.textChannel) return;
  q.npEditedAt = Date.now();
  const payload = { embeds: [npEmbed(q)], components: npRows(q) };
  try {
    if (q.npMessage && !relocate) q.npMessage = await q.npMessage.edit(payload);
    else {
      if (q.npMessage) { try { await q.npMessage.delete(); } catch {} }
      q.npMessage = await q.textChannel.send(payload);
    }
  } catch { try { q.npMessage = await q.textChannel.send(payload); } catch {} }
}

/* ============================ voice ============================ */
async function awaitVoiceReady(q, guildId, ms = 15000) {
  const c = q.connection;
  if (!c || c.state.status === VoiceConnectionStatus.Ready) return !!c;
  try { await entersState(c, VoiceConnectionStatus.Ready, ms); return true; } catch {}
  if (c.state.status === VoiceConnectionStatus.Destroyed) return rebuildVoice(q, guildId, ms);
  console.error(`[${guildId}] ⚠ voice stuck (${c.state.status}) — forcing rejoin`);
  try { c.rejoin(); } catch {}
  try { await entersState(c, VoiceConnectionStatus.Ready, ms); return true; } catch {}
  // rejoin() re-sends op 4 over the *same* connection and adapter. When the
  // adapter itself is dead — the usual cause is a gateway shard resume leaving
  // it bound to a socket that no longer exists — no number of rejoins will ever
  // reach Ready. Only a brand-new connection object recovers from that, so stop
  // asking politely and rebuild.
  console.error(`[${guildId}] ⚠ rejoin didn't take — rebuilding the voice connection`);
  return rebuildVoice(q, guildId, ms);
}
// Destroy whatever we have and join again from scratch, so the new connection
// gets a fresh adapter bound to the live shard.
async function rebuildVoice(q, guildId, ms = 15000) {
  const channelId = q.channelId;
  if (!channelId) return false;
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  const ch = guild ? await guild.channels.fetch(channelId).catch(() => null) : null;
  if (!ch || !ch.isVoiceBased()) { console.error(`[${guildId}] ❌ voice channel ${channelId} is gone — cannot rebuild`); return false; }
  try { q.connection?.destroy(); } catch {}
  // connect() short-circuits when it thinks the existing connection is usable;
  // clearing both fields is what makes it actually build a new one.
  q.connection = null;
  q.channelId = null;
  try { connect(guild, ch, q); }
  catch (e) {
    // Leaving channelId null would strand the guild for good: the resume sweep
    // skips any guild without one, so nothing would ever retry, and the next
    // saveState would persist the hole across restarts too. Put it back and let
    // the retry ladder keep working.
    q.channelId = channelId;
    console.error(`[${guildId}] ❌ voice rebuild failed: ${e.message}`);
    return false;
  }
  try { await entersState(q.connection, VoiceConnectionStatus.Ready, ms); }
  catch { console.error(`[${guildId}] ❌ voice never reached Ready — audio will be silent`); return false; }
  console.log(`[${guildId}] ✅ voice connection rebuilt`);
  return true;
}
function connect(guild, voiceChannel, q) {
  if (q.connection && q.channelId === voiceChannel.id && q.connection.state.status !== VoiceConnectionStatus.Destroyed) return;
  try { q.connection?.destroy(); } catch {}
  const connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true });
  q.connection = connection;
  q.channelId = voiceChannel.id;
  connection.subscribe(q.player);
  let lock = false;
  connection.on('error', (e) => console.error(`[${guild.id}] voice-error: ${e.message}`));
  connection.on('stateChange', async (_o, n) => {
    if (n.status === VoiceConnectionStatus.Disconnected) {
      // 4014 = Discord dropped us (moved, channel deleted, or a voice-server
      // reassignment). A music bot quits here; a 24/7 radio should climb back in.
      if (connection.rejoinAttempts < 8) {
        await new Promise(r => setTimeout(r, Math.min(30000, (connection.rejoinAttempts + 1) * 5000)));
        try { connection.rejoin(); } catch {}
      } else {
        console.error(`[${guild.id}] giving up rejoining after 8 attempts — will retry on next resume sweep`);
        try { connection.destroy(); } catch {}
      }
    } else if (!lock && (n.status === VoiceConnectionStatus.Connecting || n.status === VoiceConnectionStatus.Signalling)) {
      lock = true;
      try { await entersState(connection, VoiceConnectionStatus.Ready, 20000); } catch {} finally { lock = false; }
    }
  });
}
// Safety net for the case above: every 5 minutes, put any guild that has saved
// state but no live connection back on the air.
setInterval(async () => {
  for (const [guildId, q] of stations) {
    if (q.stopped || !q.station || !q.channelId) continue;
    const st = q.connection?.state?.status;
    if (st === VoiceConnectionStatus.Ready) { q.sweepNotReadySince = 0; continue; }
    if (q.connection && st !== VoiceConnectionStatus.Destroyed) {
      // Neither Ready nor Destroyed: a wedged adapter. The old test called this
      // "alive" and skipped it, which is how a `signalling` zombie survived for
      // 13 hours untouched. Give it SWEEP_STUCK_MS to sort itself out, then tear
      // it down so the reconnect below has something to replace.
      q.sweepNotReadySince ||= Date.now();
      if (Date.now() - q.sweepNotReadySince < SWEEP_STUCK_MS) continue;
      console.warn(`[${guildId}] resume sweep — voice stuck in ${st}, tearing it down`);
      try { q.connection.destroy(); } catch {}
    }
    q.sweepNotReadySince = 0;
    console.warn(`[${guildId}] resume sweep — reconnecting`);
    await resumeGuild(guildId, q.channelId, q.station, q.volume).catch(() => {});
  }
}, 5 * 60 * 1000);

// Both panel paths that start audio end the same way: fall back to the saved
// voice channel when the presser is not in one, close the picker, and play.
async function playFromPanel(i, q, vc, station) {
  const ch = vc || (q.channelId && await i.guild.channels.fetch(q.channelId).catch(() => null));
  if (!ch) return i.followUp({ content: '❌ Join a voice channel first!', flags: MessageFlags.Ephemeral }).catch(() => {});
  q.textChannel = i.channel; q.fails = 0;
  q.uiGenre = null; q.uiPage = 0;
  connect(i.guild, ch, q);
  await startStream(i.guild.id, station);
  return i.followUp({ content: `📻 Switched to **${station.name}**.`, flags: MessageFlags.Ephemeral }).catch(() => {});
}

async function resumeGuild(guildId, channelId, station, volume = 1, textChannelId = null) {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.isVoiceBased()) { console.warn(`[${guildId}] saved channel ${channelId} is gone`); return; }
  const q = getQ(guildId);
  q.volume = volume;
  // Without this the panel silently never comes back after a restart:
  // showNowPlaying returns at its first line when textChannel is unset, so the
  // bot resumed playing but posted nothing, and any UI change looked like it
  // had not deployed. Keep whatever a live command already set.
  if (!q.textChannel && textChannelId) {
    const tc = await guild.channels.fetch(textChannelId).catch(() => null);
    if (tc?.isTextBased()) q.textChannel = tc;
    else console.warn(`[${guildId}] saved text channel ${textChannelId} is gone — panel will wait for \`${PREFIX} np\``);
  }
  connect(guild, ch, q);
  await startStream(guildId, station);
}

/* ============================ commands ============================ */
async function cmdPlay(guild, voiceChannel, textChannel, arg) {
  if (!voiceChannel) return { content: '❌ Join a voice channel first!' };
  const q = getQ(guild.id);
  q.textChannel = textChannel;
  let station = null;
  const a = (arg || '').trim();
  if (!a) station = q.station || await resolveStationId(DEFAULT_STATION);
  else station = stationFromUrl(a) || findStation(a);
  // Not a known id or URL — treat it as a search and take the top hit.
  if (!station && a) {
    const hits = await searchStations(a, 1);
    if (hits.length) station = hits[0];
  }
  if (!station) return { content: `❌ No station matched **${a}**. Try \`${PREFIX} stations\` or \`${PREFIX} search ${a}\`.` };
  q.fails = 0;
  connect(guild, voiceChannel, q);
  await startStream(guild.id, station);
  return { content: `📻 Now playing **${station.name}** in <#${voiceChannel.id}> — 24/7 until you stop it.` };
}
function cmdStations() {
  const byGenre = new Map();
  for (const s of BUILTIN) { if (!byGenre.has(s.genre)) byGenre.set(s.genre, []); byGenre.get(s.genre).push(s); }
  const e = new EmbedBuilder().setColor(0x9B59B6).setTitle('📻 Built-in stations')
    .setDescription(`Play one with \`${PREFIX} play <id>\`. For anything else, \`${PREFIX} search <query>\` searches ~50,000 real stations.`);
  for (const [genre, list] of byGenre) e.addFields({ name: genre, value: list.map(s => `\`${s.id}\` — ${s.name}`).join('\n'), inline: false });
  return { embeds: [e] };
}
async function cmdSearch(arg) {
  const query = (arg || '').trim();
  if (!query) return { content: `❌ Usage: \`${PREFIX} search <query>\` — e.g. \`${PREFIX} search jazz country:JP\`` };
  const hits = await searchStations(query, 20);
  if (!hits.length) return { content: `❌ Nothing found for **${query}**. Try a broader word, or \`tag:lofi\` / \`country:MY\`.` };
  const list = hits.slice(0, 10).map((s, i) => `\`${i + 1}.\` **${s.name}** — ${s.genre}${s.country ? ` · ${s.country}` : ''}${s.bitrate ? ` · ${s.bitrate}kbps` : ''}`).join('\n');
  const menu = new StringSelectMenuBuilder().setCustomId('r_pick').setPlaceholder('▶️ Pick a station to play…')
    .addOptions(hits.slice(0, 25).map(s => ({
      label: s.name.slice(0, 100),
      description: `${s.genre}${s.country ? ' · ' + s.country : ''}${s.bitrate ? ' · ' + s.bitrate + 'kbps' : ''}`.slice(0, 100),
      value: s.id.slice(0, 100),
    })));
  return {
    embeds: [new EmbedBuilder().setColor(0x9B59B6).setTitle(`🔎 ${hits.length} stations for “${query}”`).setDescription(list).setFooter({ text: 'via radio-browser.info' })],
    components: [new ActionRowBuilder().addComponents(menu)],
  };
}
function cmdNp(guild, textChannel) {
  const q = getQ(guild.id);
  if (!q.station) return { content: `❌ Nothing on air. Start it with \`${PREFIX} play\`.` };
  if (textChannel) q.textChannel = textChannel;
  showNowPlaying(q, { relocate: true });
  return { _silent: true };
}
// Volume is baked in by ffmpeg, so a change means rebuilding the chain — about a
// one-second gap. Cheaper than decoding and re-encoding the stream continuously.
async function cmdVolume(guild, arg) {
  const q = getQ(guild.id);
  const v = parseInt(String(arg).replace('%', '').trim(), 10);
  if (isNaN(v)) return { content: `🔊 Volume is **${Math.round(q.volume * 100)}%**. Set it with \`${PREFIX} volume 50\` (0–200).` };
  q.volume = Math.max(0, Math.min(200, v)) / 100;
  saveState();
  if (q.station && q.streaming) await startStream(guild.id, q.station);
  return { content: `🔊 Volume set to **${Math.round(q.volume * 100)}%**.` };
}
function cmdStop(guild) {
  const q = getQ(guild.id);
  stopStream(guild.id, { keepConnection: false });
  q.station = null; q.channelId = null; q.nowPlaying = null;
  if (q.npMessage) { q.npMessage.delete().catch(() => {}); q.npMessage = null; }
  stations.delete(guild.id);
  saveState(); updatePresence();
  return { content: '⏹️ Off air — left the voice channel.' };
}
async function cmdRandom(guild, voiceChannel, textChannel) {
  const pick = BUILTIN[Math.floor(Math.random() * BUILTIN.length)];
  const q = getQ(guild.id);
  const ch = voiceChannel || (q.channelId && await guild.channels.fetch(q.channelId).catch(() => null));
  if (!ch) return { content: '❌ Join a voice channel first!' };
  return cmdPlay(guild, ch, textChannel || q.textChannel, pick.id);
}
function helpEmbed() {
  return new EmbedBuilder().setColor(0x9B59B6).setTitle('📻 Radio — commands')
    .setDescription(`Prefix everything with **\`${PREFIX}\`** (e.g. \`${PREFIX} play lofigirl\`), or use \`/radio\`.`)
    .addFields(
      { name: '▶️ Play', value: `\`${PREFIX} play\` — start the default station\n\`${PREFIX} play <id | name | stream URL>\`\n\`${PREFIX} random\` — surprise me`, inline: false },
      { name: '🔎 Find stations', value: `\`${PREFIX} stations\` — the built-in list\n\`${PREFIX} search <query>\` — ~50,000 stations worldwide\nFilters: \`${PREFIX} search jazz country:JP\` · \`${PREFIX} search tag:lofi\``, inline: false },
      { name: '🎛️ Control', value: `\`${PREFIX} np\` — now playing · \`${PREFIX} volume 50\` · \`${PREFIX} stop\``, inline: false },
      { name: '♾️ 24/7', value: 'Once started it stays on air — it reconnects through stream drops, Discord voice kicks, and bot restarts, and falls back to another station if one goes down for good.', inline: false },
    );
}

const COMMANDS = {
  play: (c) => cmdPlay(c.guild, c.voiceChannel, c.textChannel, c.arg),
  p: (c) => cmdPlay(c.guild, c.voiceChannel, c.textChannel, c.arg),
  stations: () => cmdStations(),
  list: () => cmdStations(),
  search: (c) => cmdSearch(c.arg),
  np: (c) => cmdNp(c.guild, c.textChannel),
  nowplaying: (c) => cmdNp(c.guild, c.textChannel),
  volume: (c) => cmdVolume(c.guild, c.arg),
  vol: (c) => cmdVolume(c.guild, c.arg),
  random: (c) => cmdRandom(c.guild, c.voiceChannel, c.textChannel),
  stop: (c) => cmdStop(c.guild),
  leave: (c) => cmdStop(c.guild),
  help: () => ({ embeds: [helpEmbed()] }),
};

/* ============================ discord wiring ============================ */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// discord.js renamed 'ready' → 'clientReady' partway through v14, and emits a
// deprecation warning for the old name. Listen for both, run once, so this works
// across the whole v14 range without a warning on either.
let _booted = false;
const onReady = (fn) => { for (const ev of ['clientReady', 'ready']) client.once(ev, (...a) => { if (_booted) return; _booted = true; fn(...a); }); };

onReady(async () => {
  console.log(`✅ ${client.user.tag} online`);
  updatePresence();
  await registerSlash().catch(e => console.error(`[slash] ${e.message}`));
  // Auto-resume: put every guild back on the air exactly where it was.
  for (const [guildId, s] of Object.entries(saved)) {
    try {
      const station = await resolveStationId(s.stationId);
      if (!station) { console.warn(`[${guildId}] saved station ${s.stationId} no longer resolves`); continue; }
      await resumeGuild(guildId, s.channelId, station, s.volume ?? 1, s.textChannelId);
    } catch (e) { console.error(`[${guildId}] resume failed: ${e.message}`); }
  }
});

async function registerSlash() {
  const body = [new SlashCommandBuilder().setName('radio').setDescription('24/7 radio')
    .addSubcommand(s => s.setName('play').setDescription('Start a station in your voice channel')
      .addStringOption(o => o.setName('station').setDescription('id, name, search terms, or a stream URL')))
    .addSubcommand(s => s.setName('stations').setDescription('List the built-in stations'))
    .addSubcommand(s => s.setName('search').setDescription('Search ~50,000 stations worldwide')
      .addStringOption(o => o.setName('query').setDescription('e.g. "lofi", "jazz country:JP"').setRequired(true)))
    .addSubcommand(s => s.setName('np').setDescription('Show what is playing'))
    .addSubcommand(s => s.setName('random').setDescription('Play a random station'))
    .addSubcommand(s => s.setName('volume').setDescription('Set volume (0-200%)')
      .addIntegerOption(o => o.setName('level').setDescription('0-200').setRequired(true)))
    .addSubcommand(s => s.setName('stop').setDescription('Go off air and leave'))
    .toJSON()];
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const gid = process.env.GUILD_ID;
  if (gid) await rest.put(Routes.applicationGuildCommands(client.user.id, gid), { body });
  else await rest.put(Routes.applicationCommands(client.user.id), { body });
  console.log(`[slash] registered ${gid ? `to guild ${gid}` : 'globally'}`);
}

async function reply(target, res, ephemeral = false) {
  if (!res || res._silent) { if (target.isChatInputCommand?.()) await target.deleteReply().catch(() => {}); return; }
  const payload = { content: res.content, embeds: res.embeds, components: res.components };
  if (target.isChatInputCommand?.()) await target.editReply(payload).catch(() => {});
  else await target.reply({ ...payload, ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}) }).catch(() => {});
}

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.guild) return;
  const re = new RegExp(`^${PREFIX}\\b\\s*`, 'i');
  if (!re.test(msg.content)) return;
  const rest = msg.content.replace(re, '').trim();
  const [name, ...restArgs] = rest.split(/\s+/);
  const key = (name || 'help').toLowerCase();
  const fn = COMMANDS[key];
  const ctx = { guild: msg.guild, voiceChannel: msg.member?.voice?.channel, textChannel: msg.channel, arg: restArgs.join(' '), userId: msg.author.id };
  // `lofi` alone, or `lofi <something unknown>`, is almost always "just play it".
  if (!fn) return reply(msg, await cmdPlay(msg.guild, ctx.voiceChannel, msg.channel, rest).catch(errRes));
  try { await reply(msg, await fn(ctx)); }
  catch (e) { console.error(`[${msg.guild.id}] ${key}: ${e.message}`); await reply(msg, errRes(e)); }
});

const errRes = (e) => ({ content: `❌ ${String(e.message || e).slice(0, 300)}` });

client.on('interactionCreate', async (i) => {
  if (!i.guild) return;   // every command here is guild-scoped; DMs would crash on i.guild.id
  try {
    if (i.isChatInputCommand() && i.commandName === 'radio') {
      await i.deferReply();
      const sub = i.options.getSubcommand();
      const ctx = {
        guild: i.guild, voiceChannel: i.member?.voice?.channel, textChannel: i.channel,
        arg: i.options.getString('station') || i.options.getString('query') || String(i.options.getInteger('level') ?? ''),
        userId: i.user.id,
      };
      return reply(i, await (COMMANDS[sub] || COMMANDS.help)(ctx));
    }
    if (i.isStringSelectMenu()) {
      await i.deferUpdate();
      const q = getQ(i.guild.id);
      const vc = i.member?.voice?.channel || (q.channelId && await i.guild.channels.fetch(q.channelId).catch(() => null));
      if (!vc) return i.followUp({ content: '❌ Join a voice channel first!', flags: MessageFlags.Ephemeral }).catch(() => {});
      const station = await resolveStationId(i.values[0]);
      if (!station) return i.followUp({ content: '❌ That station no longer resolves.', flags: MessageFlags.Ephemeral }).catch(() => {});
      q.textChannel = i.channel; q.fails = 0;
      connect(i.guild, vc, q);
      await startStream(i.guild.id, station);
      return i.followUp({ content: `📻 Switched to **${station.name}**.`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    if (i.isButton()) {
      const q = getQ(i.guild.id);
      const vc = i.member?.voice?.channel;
      if (i.customId === 'r_stop') { await i.deferUpdate(); cmdStop(i.guild); return i.followUp({ content: '⏹️ Off air.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
      if (i.customId === 'r_refresh') { await i.deferUpdate(); return showNowPlaying(q); }
      if (i.customId === 'r_random') { await i.deferUpdate(); await cmdRandom(i.guild, vc, i.channel); return; }
      // Genre tapped: open its station page. A genre holding exactly one station
      // has nothing to choose between, so play it rather than showing a page of
      // one button.
      if (i.customId.startsWith('r_g_')) {
        await i.deferUpdate();
        const genre = i.customId.slice(4);
        const list = inGenre(genre);
        if (!list.length) return i.followUp({ content: '❌ No stations in that genre.', flags: MessageFlags.Ephemeral }).catch(() => {});
        if (list.length > 1) { q.uiGenre = genre; q.uiPage = 0; return showNowPlaying(q); }
        return playFromPanel(i, q, vc, list[0]);
      }
      if (i.customId === 'r_pg_prev' || i.customId === 'r_pg_next') {
        await i.deferUpdate();
        q.uiPage = Math.max(0, (q.uiPage || 0) + (i.customId === 'r_pg_next' ? 1 : -1));
        return showNowPlaying(q);
      }
      if (i.customId === 'r_back') {
        await i.deferUpdate();
        q.uiGenre = null; q.uiPage = 0;
        return showNowPlaying(q);
      }
      if (i.customId.startsWith('r_s_')) {
        await i.deferUpdate();
        const station = await resolveStationId(i.customId.slice(4));
        if (!station) return i.followUp({ content: '❌ That station no longer resolves.', flags: MessageFlags.Ephemeral }).catch(() => {});
        return playFromPanel(i, q, vc, station);
      }
      if (i.customId === 'r_volup' || i.customId === 'r_voldown') {
        await i.deferUpdate();
        const delta = i.customId === 'r_volup' ? 10 : -10;
        await cmdVolume(i.guild, Math.round(q.volume * 100) + delta);
        return showNowPlaying(q);
      }
    }
  } catch (e) {
    console.error(`interaction: ${e.message}`);
    if (i.isRepliable()) i.followUp({ content: `❌ ${e.message}`.slice(0, 300), flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// Optional: cut the stream while nobody is listening, resume when someone joins.
// Saves CPU and ~1GB/day of bandwidth per idle server; off by default because
// "24/7" usually means literally always on.
client.on('voiceStateUpdate', async (oldS, newS) => {
  if (!PAUSE_WHEN_EMPTY) return;
  const guild = newS.guild || oldS.guild;
  const guildId = guild?.id;
  const q = stations.get(guildId);
  if (!q || !q.channelId || !q.station) return;
  // Only react to movement in/out of the channel we're actually broadcasting to.
  if (oldS.channelId !== q.channelId && newS.channelId !== q.channelId) return;
  const ch = guild.channels.cache.get(q.channelId) || await guild.channels.fetch(q.channelId).catch(() => null);
  if (!ch || !ch.isVoiceBased()) return;
  const listeners = ch.members.filter(m => !m.user.bot).size;
  if (listeners === 0 && q.streaming) {
    console.log(`[${guildId}] 💤 channel empty — pausing stream`);
    stopStream(guildId, { keepConnection: true });
  } else if (listeners > 0 && !q.streaming && q.stopped) {
    console.log(`[${guildId}] 👋 listener joined — resuming stream`);
    await startStream(guildId, q.station).catch(() => {});
  }
});

/* ============================ lifecycle ============================ */
// Refresh the "uptime" field and keep presence honest without spamming edits.
setInterval(() => { for (const q of stations.values()) if (q.streaming && q.npMessage) showNowPlaying(q); }, 10 * 60 * 1000);
setInterval(updatePresence, 60 * 1000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig} — shutting down`);
    for (const [guildId] of stations) stopStream(guildId, { keepConnection: false });
    try { client.destroy(); } catch {}
    process.exit(0);
  });
}
// A 24/7 process must not die on a stray rejection from a background promise.
process.on('unhandledRejection', (e) => console.error(`[unhandled] ${e?.message || e}`));
process.on('uncaughtException', (e) => console.error(`[uncaught] ${e?.stack || e}`));

client.login(TOKEN);
