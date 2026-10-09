// stations.js — the built-in station catalog, plus live lookup against
// radio-browser.info (a free, keyless, community database of ~50k stations).
//
// Two station types:
//   'icecast'  — a direct HTTP stream URL. ffmpeg consumes it as-is. Rock solid,
//                and it carries ICY metadata so we get real now-playing titles.
//   'youtube'  — a YouTube *live* stream. yt-dlp resolves the HLS manifest URL and
//                ffmpeg streams it directly (see bot.js). No ICY metadata; the
//                title is the stream's video title, fetched once at connect.
import './env.js';           // must come first — see env.js
import { execFile } from 'child_process';
import { promisify } from 'util';
import https from 'https';
import http from 'http';
import { connect as netConnect } from 'net';

const execFileAsync = promisify(execFile);
const YT_DLP = process.env.YT_DLP_PATH || '/home/lonelyslack/bin/yt-dlp';
// Route yt-dlp through Cloudflare WARP — see bot.js for why. This must be an
// http:// proxy, not socks5://: ffmpeg fetches the manifest and segments itself
// and libavformat only honours a proxy value literally starting with "http://"
// (av_strstart in http.c / tls.c), so a socks5:// value is silently ignored and
// the request goes out direct. privoxy bridges CONNECT to WARP's SOCKS listener.
const YT_PROXY = process.env.YT_DLP_PROXY ?? 'http://127.0.0.1:8118';
export function ytArgs(proxy) {
  return ['--js-runtimes', 'node', ...(proxy ? ['--proxy', proxy] : [])];
}

// The bridge is a separate process (privoxy) fronting a separate daemon (WARP),
// and either can stop without the bot noticing. When that happens every YouTube
// station becomes an unresolvable station, and the retry ladder marches to the
// fallback while the direct path would have worked fine - which is the worse
// outcome, because WARP is a workaround for bot-flagging, not a requirement.
// So probe it, and degrade to direct rather than to silence.
const PROXY_OK_TTL = 60000;   // it answered; don't re-probe for a while
const PROXY_BAD_TTL = 10000;  // it didn't; notice recovery quickly
let _proxyCheckedAt = 0, _proxyOk = false;

function tcpProbe(host, port, ms = 1500) {
  return new Promise(resolve => {
    const sock = netConnect({ host, port });
    let settled = false;
    const done = ok => { if (settled) return; settled = true; sock.destroy(); resolve(ok); };
    sock.setTimeout(ms);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

// Which proxy YouTube should use right now - the configured one when the bridge
// answers, otherwise '' for direct. yt-dlp resolves the manifest and ffmpeg
// fetches the segments, and the manifest is IP-locked to whoever fetched it, so
// both hops MUST agree. Resolve this once per attempt and hand the same value
// to both; never call it twice for one stream.
export async function ytProxy() {
  if (!YT_PROXY) return '';
  const now = Date.now();
  if (now - _proxyCheckedAt < (_proxyOk ? PROXY_OK_TTL : PROXY_BAD_TTL)) return _proxyOk ? YT_PROXY : '';
  let host, port;
  try { const u = new URL(YT_PROXY); host = u.hostname; port = Number(u.port) || 80; }
  catch { return ''; }
  const ok = await tcpProbe(host, port);
  if (ok !== _proxyOk || !_proxyCheckedAt) {
    console.warn(ok
      ? `[warp] bridge up at ${YT_PROXY} — YouTube via WARP`
      : `[warp] bridge unreachable at ${YT_PROXY} — YouTube falling back to direct`);
  }
  _proxyOk = ok; _proxyCheckedAt = now;
  return ok ? YT_PROXY : '';
}

/* ============================ built-in catalog ============================ */
// Hand-picked stations that are reliable enough to hardcode. Everything else
// comes from `lofi search <query>` at runtime, so this list stays short.
//
// SomaFM is listener-supported and explicitly allows direct stream links.
// Radio Paradise is human-curated with excellent audio quality.
// The YouTube entries point at channel /live URLs rather than video ids, because
// a 24/7 channel restarts its broadcast periodically and the video id changes —
// the /live URL always resolves to whatever is airing right now.
export const BUILTIN = [
  // ---- lofi / chill (the default vibe) ----
  { id: 'lofigirl',       name: 'Lofi Girl',            type: 'youtube', genre: 'lofi',      url: 'https://www.youtube.com/@LofiGirl/live' },
  { id: 'somafm-fluid',   name: 'SomaFM Fluid',         type: 'icecast', genre: 'lofi',      url: 'https://ice1.somafm.com/fluid-128-mp3' },
  { id: 'chillhop',       name: 'Chillhop Music',       type: 'youtube', genre: 'lofi',      url: 'https://www.youtube.com/@ChillhopMusic/live' },
  { id: 'bootlegboy',     name: 'The Bootleg Boy',      type: 'youtube', genre: 'lofi',      url: 'https://www.youtube.com/@thebootlegboy/live' },
  { id: 'somafm-groove',  name: 'SomaFM Groove Salad',  type: 'icecast', genre: 'chill',     url: 'https://ice1.somafm.com/groovesalad-128-mp3' },
  { id: 'somafm-lush',    name: 'SomaFM Lush',          type: 'icecast', genre: 'chill',     url: 'https://ice1.somafm.com/lush-128-mp3' },
  { id: 'somafm-drone',   name: 'SomaFM Drone Zone',    type: 'icecast', genre: 'ambient',   url: 'https://ice1.somafm.com/dronezone-128-mp3' },
  { id: 'somafm-deep',    name: 'SomaFM Deep Space One',type: 'icecast', genre: 'ambient',   url: 'https://ice1.somafm.com/deepspaceone-128-mp3' },
  { id: 'somafm-blender', name: 'SomaFM Beat Blender',  type: 'icecast', genre: 'downtempo', url: 'https://ice1.somafm.com/beatblender-128-mp3' },
  { id: 'somafm-trip',    name: 'SomaFM The Trip',      type: 'icecast', genre: 'downtempo', url: 'https://ice1.somafm.com/thetrip-128-mp3' },
  { id: 'somafm-space',   name: 'SomaFM Space Station', type: 'icecast', genre: 'ambient',   url: 'https://ice1.somafm.com/spacestation-128-mp3' },
  // ---- other genres (it's a radio bot, not just a lofi bot) ----
  { id: 'rp-main',        name: 'Radio Paradise',       type: 'icecast', genre: 'eclectic',  url: 'https://stream.radioparadise.com/mp3-192' },
  { id: 'rp-mellow',      name: 'Radio Paradise Mellow',type: 'icecast', genre: 'mellow',    url: 'https://stream.radioparadise.com/mellow-192' },
  { id: 'rp-rock',        name: 'Radio Paradise Rock',  type: 'icecast', genre: 'rock',      url: 'https://stream.radioparadise.com/rock-192' },
  { id: 'rp-global',      name: 'Radio Paradise Global',type: 'icecast', genre: 'world',     url: 'https://stream.radioparadise.com/global-192' },
  { id: 'somafm-secret',  name: 'SomaFM Secret Agent',  type: 'icecast', genre: 'lounge',    url: 'https://ice1.somafm.com/secretagent-128-mp3' },
  { id: 'somafm-indie',   name: 'SomaFM Indie Pop',     type: 'icecast', genre: 'indie',     url: 'https://ice1.somafm.com/indiepop-128-mp3' },
  { id: 'somafm-u80s',    name: 'SomaFM Underground 80s',type:'icecast', genre: 'synth',     url: 'https://ice1.somafm.com/u80s-128-mp3' },
  { id: 'somafm-metal',   name: 'SomaFM Metal Detector',type: 'icecast', genre: 'metal',     url: 'https://ice1.somafm.com/metal-128-mp3' },
  { id: 'somafm-defcon',  name: 'SomaFM DEF CON Radio', type: 'icecast', genre: 'electronic',url: 'https://ice1.somafm.com/defcon-128-mp3' },
  { id: 'somafm-goa',     name: 'SomaFM Suburbs of Goa',type: 'icecast', genre: 'world',     url: 'https://ice1.somafm.com/suburbsofgoa-128-mp3' },
  { id: 'somafm-boot',    name: 'SomaFM Boot Liquor',   type: 'icecast', genre: 'country',   url: 'https://ice1.somafm.com/bootliquor-128-mp3' },
  // ---- YouTube 24/7 live: sleep, nature, focus ---------------------------
  // Channel /live URLs, same reasoning as Lofi Girl above. These are real
  // broadcasts rather than loops, so a channel that ends its stream stops
  // resolving until the next one starts - the fallback covers that.
  { id: 'sleep',          name: 'Deep Sleep Music',     type: 'youtube', genre: 'sleep',     url: 'https://www.youtube.com/@YellowBrickCinema/live' },
  { id: 'whitenoise',     name: 'Relaxing White Noise', type: 'youtube', genre: 'sleep',     url: 'https://www.youtube.com/@RelaxingWhiteNoise/live' },
  { id: 'rain',           name: 'Rain Sounds',          type: 'youtube', genre: 'sleep',     url: 'https://www.youtube.com/@TheRelaxedGuy/live' },
  { id: 'piano',          name: 'Beautiful Piano',      type: 'youtube', genre: 'piano',     url: 'https://www.youtube.com/@SoothingRelaxation/live' },
  { id: 'cafejazz',       name: 'Cafe Music BGM',       type: 'youtube', genre: 'jazz',      url: 'https://www.youtube.com/@CafeMusicBGMchannel/live' },
  { id: 'calmed',         name: 'Calmed By Nature',     type: 'youtube', genre: 'jazz',      url: 'https://www.youtube.com/@CalmedByNature/live' },
  { id: 'focus',          name: 'Focus & Study',        type: 'youtube', genre: 'focus',     url: 'https://www.youtube.com/@GreenredProductions/live' },
  // ---- Quran (24/7 recitations) ------------------------------------------
  { id: 'quran-mishary',  name: 'Mishary Alafasy',      type: 'icecast', genre: 'quran',     url: 'https://qurango.net/radio/mishary_alafasi' },
  { id: 'quran-sakeenah', name: 'Calm Recitations',     type: 'icecast', genre: 'quran',     url: 'https://qurango.net/radio/sakeenah' },
  { id: 'quran-cairo',    name: 'Quran Radio Cairo',    type: 'icecast', genre: 'quran',     url: 'https://stream.radiojar.com/8s5u5tpdtwzuv' },
  // ---- Malaysia ----------------------------------------------------------
  // Astro Radio and RTM both publish open stream endpoints. The Astro ones are
  // given as the stable stream.rcs.revma.com/<id> form rather than the
  // n<NN>-eu.rcs.revma.com edge URLs radio-browser hands out, which are
  // session-specific and rotate. None of these carry ICY metadata, so `np`
  // shows the station name rather than the current song.
  { id: 'era',         name: 'ERA FM',            type: 'icecast', genre: 'malaysia', url: 'https://stream.rcs.revma.com/crec9cmbv4uvv' },
  { id: 'hitz',        name: 'HITZ',              type: 'icecast', genre: 'malaysia', url: 'https://stream.rcs.revma.com/488kt4sbv4uvv' },
  { id: 'sinar',       name: 'SINAR FM',          type: 'icecast', genre: 'malaysia', url: 'https://stream.rcs.revma.com/azatk0tbv4uvv' },
  { id: 'melody',      name: 'MELODY FM',         type: 'icecast', genre: 'malaysia', url: 'https://stream.rcs.revma.com/2u1n6dtbv4uvv' },
  { id: 'lite',        name: 'LITE FM',           type: 'icecast', genre: 'malaysia', url: 'https://stream.rcs.revma.com/bn4ex8sbv4uvv' },
  { id: 'zayan',       name: 'ZAYAN',             type: 'icecast', genre: 'malaysia', url: 'https://stream.rcs.revma.com/7ww2a4tbv4uvv' },
  { id: 'gegar',       name: 'THR Gegar',         type: 'icecast', genre: 'malaysia', url: 'https://stream.rcs.revma.com/cn0zcqsbv4uvv' },
  { id: 'raaga',       name: 'RAAGA',             type: 'icecast', genre: 'malaysia', url: 'https://stream.rcs.revma.com/1ut6qwtbv4uvv' },
  { id: 'goxuan',      name: 'goXuan',            type: 'icecast', genre: 'malaysia', url: 'https://stream.rcs.revma.com/xt9nhzsbv4uvv' },
  { id: 'era-swk',     name: 'ERA Sarawak',       type: 'icecast', genre: 'malaysia', url: 'https://stream.rcs.revma.com/bkqfqkrbv4uvv' },
  { id: 'bfm',         name: 'BFM 89.9',          type: 'icecast', genre: 'malaysia', url: 'https://stream.rcs.revma.com/s91qy9p0zs3vv' },
  { id: '988',         name: '988 FM',            type: 'icecast', genre: 'malaysia', url: 'https://28103.live.streamtheworld.com/988_FMAAC.aac' },
  { id: 'fly',         name: 'Fly FM',            type: 'icecast', genre: 'malaysia', url: 'https://stream.rcs.revma.com/q17aka9mtd3vv' },
  { id: 'hot',         name: 'Hot FM',            type: 'icecast', genre: 'malaysia', url: 'https://stream.rcs.revma.com/drakdf8mtd3vv' },
  { id: 'eight',       name: 'Eight FM',          type: 'icecast', genre: 'malaysia', url: 'https://stream.rcs.revma.com/qp0xrd9mtd3vv' },
  { id: 'cats',        name: 'Cats FM',           type: 'icecast', genre: 'malaysia', url: 'https://stream.rcs.revma.com/51qe53rv0y3vv' },
  { id: 'cityplus',    name: 'CITYPlus FM',       type: 'icecast', genre: 'malaysia', url: 'https://stream.rcs.revma.com/9ykdmcawe1bwv' },
  { id: 'redfm',       name: 'RED FM',            type: 'icecast', genre: 'malaysia', url: 'https://22273.live.streamtheworld.com/RED_FMAAC.aac' },
  { id: 'amboi',       name: 'Amboi FM',          type: 'icecast', genre: 'malaysia', url: 'http://amboifm.iradio.work:8000/stream' },
  { id: 'nasional',    name: 'Nasional FM',       type: 'icecast', genre: 'malaysia', url: 'http://playerservices.streamtheworld.com/api/livestream-redirect/NASIONAL_FM.mp3' },
  { id: 'klasik',      name: 'Klasik Nasional',   type: 'icecast', genre: 'malaysia', url: 'http://playerservices.streamtheworld.com/api/livestream-redirect/RADIO_KLASIK.mp3' },
  { id: 'traxx',       name: 'TraXX FM',          type: 'icecast', genre: 'malaysia', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/TRAXX_FMAAC_SC' },
  { id: 'aifm',        name: 'Ai FM',             type: 'icecast', genre: 'malaysia', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/AI_FMAAC_SC' },
  { id: 'asyik',       name: 'Asyik FM',          type: 'icecast', genre: 'malaysia', url: 'http://playerservices.streamtheworld.com/api/livestream-redirect/ASYIK_FM.mp3' },
  { id: 'kelantan',    name: 'Kelantan FM',       type: 'icecast', genre: 'malaysia', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/KELANTAN_FMAAC.aac' },
  { id: 'terengganu',  name: 'Terengganu FM',     type: 'icecast', genre: 'malaysia', url: 'https://22243.live.streamtheworld.com/TERENGGANU_FMAAC_SC' },
  { id: 'sabah',       name: 'Sabah FM',          type: 'icecast', genre: 'malaysia', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/SABAH_FMAAC.aac' },
  { id: 'langkawi',    name: 'Langkawi FM',       type: 'icecast', genre: 'malaysia', url: 'http://playerservices.streamtheworld.com/api/livestream-redirect/LANGKAWI_FM.mp3' },
  { id: 'keningau',    name: 'Keningau FM',       type: 'icecast', genre: 'malaysia', url: 'http://playerservices.streamtheworld.com/api/livestream-redirect/KENINGAU_FM.mp3' },
  { id: 'wai-iban',    name: 'WAI FM Iban',       type: 'icecast', genre: 'malaysia', url: 'http://playerservices.streamtheworld.com/api/livestream-redirect/WAI_FM_IBAN.mp3' },
  { id: 'wai-bidayuh', name: 'WAI FM Bidayuh',    type: 'icecast', genre: 'malaysia', url: 'http://playerservices.streamtheworld.com/api/livestream-redirect/WAI_FM_BK.mp3' },
];

const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Resolve "somafm-fluid", "Groove Salad", "groove" → a catalog entry.
export function findStation(query) {
  const q = norm(query);
  if (!q) return null;
  return BUILTIN.find(s => norm(s.id) === q)
      || BUILTIN.find(s => norm(s.name) === q)
      || BUILTIN.find(s => norm(s.name).includes(q) || norm(s.id).includes(q))
      || null;
}
// A bare URL typed into `lofi play` becomes an ad-hoc station.
export function stationFromUrl(url) {
  if (!/^https?:\/\//i.test(url)) return null;
  const yt = /(?:youtube\.com|youtu\.be)/i.test(url);
  return { id: 'custom', name: yt ? 'YouTube live' : 'Custom stream', type: yt ? 'youtube' : 'icecast', genre: 'custom', url, custom: true };
}

/* ============================ radio-browser.info ============================ */
// Free + keyless, but it asks for a real User-Agent so operators can see who's
// calling. `all.api.radio-browser.info` is round-robin DNS across their mirrors.
const RB_HOST = 'all.api.radio-browser.info';
const RB_UA = 'LofiRadioBot/1.0 (+discord bot)';

function rbGet(path) {
  return new Promise((resolve) => {
    const req = https.get({ hostname: RB_HOST, path, timeout: 12000, headers: { 'User-Agent': RB_UA } }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
// Search stations by free text, optionally narrowed by `country:XX` / `tag:word`
// tokens embedded in the query (e.g. "jazz country:JP").
export async function searchStations(query, limit = 20) {
  let q = (query || '').trim();
  const params = new URLSearchParams({
    limit: String(limit * 3),   // over-fetch: we filter out unplayable ones below
    hidebroken: 'true',
    order: 'votes',
    reverse: 'true',
  });
  const country = q.match(/\bcountry:([A-Za-z]{2})\b/i);
  if (country) { params.set('countrycode', country[1].toUpperCase()); q = q.replace(country[0], ' '); }
  const tag = q.match(/\btag:(\S+)\b/i);
  if (tag) { params.set('tag', tag[1].toLowerCase()); q = q.replace(tag[0], ' '); }
  q = q.replace(/\s+/g, ' ').trim();
  if (q) params.set('name', q);
  else if (!tag && !country) params.set('tag', 'lofi');   // bare `lofi search` → lofi stations

  const rows = await rbGet(`/json/stations/search?${params}`);
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  return rows
    // url_resolved follows the station's .pls/.m3u redirect to the real stream.
    // Skip HLS/video-ish entries — ffmpeg handles them, but they're rarely music radio.
    .filter(r => r.url_resolved && !/\.m3u8(\?|$)/i.test(r.url_resolved))
    .filter(r => { const k = r.url_resolved.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, limit)
    .map(r => ({
      id: `rb:${r.stationuuid}`,
      name: (r.name || 'Unknown').trim().slice(0, 80),
      type: 'icecast',
      genre: (r.tags || '').split(',')[0] || 'radio',
      url: r.url_resolved,
      country: r.countrycode || '',
      bitrate: r.bitrate || 0,
      votes: r.votes || 0,
      custom: true,
    }));
}
// Re-resolve a radio-browser station by uuid — its stream URL can change between
// restarts, so a guild that auto-resumes onto `rb:<uuid>` looks it up fresh.
export async function stationByUuid(uuid) {
  const rows = await rbGet(`/json/stations/byuuid/${encodeURIComponent(uuid)}`);
  const r = Array.isArray(rows) && rows[0];
  if (!r || !r.url_resolved) return null;
  return {
    id: `rb:${r.stationuuid}`, name: (r.name || 'Unknown').trim().slice(0, 80),
    type: 'icecast', genre: (r.tags || '').split(',')[0] || 'radio',
    url: r.url_resolved, country: r.countrycode || '', bitrate: r.bitrate || 0, custom: true,
  };
}

/* ============================ resolution ============================ */
// Turn a persisted station id back into a full station object (built-ins are
// looked up locally; `rb:` ids hit radio-browser again).
export async function resolveStationId(id) {
  if (!id) return null;
  if (id.startsWith('rb:')) return stationByUuid(id.slice(3));
  if (/^https?:\/\//i.test(id)) return stationFromUrl(id);
  return findStation(id);
}

// A YouTube live stream has no ICY metadata, so grab the video title once at
// connect time and use it as the "now playing" line. Best-effort: a failure here
// must not stop playback, so callers ignore rejections.
export async function youtubeLiveTitle(url) {
  const { stdout } = await execFileAsync(
    YT_DLP, [...ytArgs(await ytProxy()), url, '--no-playlist', '--no-download', '--print', '%(title)s'],
    { timeout: 30000 }
  );
  return (stdout || '').trim().split('\n').filter(Boolean).pop() || null;
}

// Resolve a YouTube live URL to its HLS manifest. yt-dlp does extraction only —
// ffmpeg does the actual streaming — so this runs once per (re)connect. The
// manifest carries an `expire` param a few hours out; when it lapses ffmpeg
// fails, the watchdog fires, and the retry re-resolves through here.
// Returns { manifest, proxy }. The proxy is reported back rather than re-derived
// by the caller because ffmpeg must fetch the segments from the same egress that
// resolved the manifest - re-deriving risks the bridge flipping state between
// the two calls and every segment coming back 403.
export async function youtubeManifestUrl(url) {
  const proxy = await ytProxy();
  const { stdout } = await execFileAsync(
    YT_DLP, [...ytArgs(proxy), '-f', 'ba[protocol^=m3u8]/ba/b', '--no-playlist', '-g', url],
    { timeout: 45000 }
  );
  const manifest = (stdout || '').trim().split('\n').filter(Boolean)[0];
  if (!manifest) throw new Error('yt-dlp returned no manifest URL');
  return { manifest, proxy };
}

/* ============================ ICY now-playing ============================ */
// Reading the title straight off the Icecast/SHOUTcast protocol, rather than
// scraping ffmpeg's stderr, because ffmpeg only logs "Metadata update for
// StreamTitle" when the title CHANGES — so a fresh listener sees nothing until
// the next track, and the exact log wording varies between ffmpeg versions.
//
// The protocol: ask with `Icy-MetaData: 1`, and the server answers with an
// `icy-metaint` header — every N bytes of audio it splices in a metadata block
// (1 length byte = blocks of 16, then `StreamTitle='...';`). We read exactly as
// far as the first block, then hang up. That's ~16KB per poll.
export function fetchIcyTitle(url, redirects = 3) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { return resolve(null); }
    const mod = u.protocol === 'https:' ? https : http;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = mod.get(u, { headers: { 'Icy-MetaData': '1', 'User-Agent': RB_UA }, timeout: 12000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.destroy();
        return finish(fetchIcyTitle(new URL(res.headers.location, url).href, redirects - 1));
      }
      const metaint = parseInt(res.headers['icy-metaint'] || '0', 10);
      if (!metaint || res.statusCode !== 200) { res.destroy(); return finish(null); }
      let skipped = 0, metaLen = -1, metaGot = 0, cycles = 0;
      const parts = [];
      res.on('data', chunk => {
        let off = 0;
        while (off < chunk.length) {
          if (skipped < metaint) {                       // still in the audio run
            const take = Math.min(metaint - skipped, chunk.length - off);
            skipped += take; off += take; continue;
          }
          if (metaLen < 0) {                             // length byte: value * 16 bytes follow
            metaLen = chunk[off] * 16; off += 1;
            if (metaLen === 0) {                         // empty block — wait for the next one
              skipped = 0; metaLen = -1;
              // A station with metadata enabled but nothing to say. Don't read forever.
              if (++cycles > 3) { res.destroy(); return finish(null); }
            }
            continue;
          }
          const take = Math.min(metaLen - metaGot, chunk.length - off);
          parts.push(chunk.subarray(off, off + take)); metaGot += take; off += take;
          if (metaGot >= metaLen) {
            const s = Buffer.concat(parts).toString('utf8');
            res.destroy();
            const m = s.match(/StreamTitle='([^']*)'/);
            return finish(m && m[1].trim() ? m[1].trim() : null);
          }
        }
      });
      res.on('error', () => finish(null));
      res.on('end', () => finish(null));
    });
    req.on('error', () => finish(null));
    req.on('timeout', () => { req.destroy(); finish(null); });
  });
}
