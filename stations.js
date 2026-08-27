// stations.js — the built-in station catalog, plus live lookup against
// radio-browser.info (a free, keyless, community database of ~50k stations).
//
// Two station types:
//   'icecast'  — a direct HTTP stream URL. ffmpeg consumes it as-is. Rock solid,
//                and it carries ICY metadata so we get real now-playing titles.
//   'youtube'  — a YouTube *live* stream. yt-dlp streams it to stdout and we pipe
//                that into ffmpeg (see bot.js). No ICY metadata; the title is the
//                stream's video title, fetched once at connect.
import { execFile } from 'child_process';
import { promisify } from 'util';
import https from 'https';
import http from 'http';

const execFileAsync = promisify(execFile);
const YT_DLP = process.env.YT_DLP_PATH || '/home/lonelyslack/bin/yt-dlp';
// Route yt-dlp through Cloudflare WARP (SOCKS proxy) — see bot.js for why.
const YT_PROXY = process.env.YT_DLP_PROXY ?? 'socks5://127.0.0.1:40000';
export const YT_ARGS = ['--js-runtimes', 'node', ...(YT_PROXY ? ['--proxy', YT_PROXY] : [])];

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
    YT_DLP, [...YT_ARGS, url, '--no-playlist', '--no-download', '--print', '%(title)s'],
    { timeout: 30000 }
  );
  return (stdout || '').trim().split('\n').filter(Boolean).pop() || null;
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
