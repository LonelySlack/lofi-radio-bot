# 📻 lofi-radio-bot

A 24/7 Discord radio bot. Joins a voice channel, plays a station, and stays there —
through stream drops, Discord voice kicks, and bot restarts.

Built to sit alongside [`music-bot`](https://github.com/LonelySlack/music-bot) and share
the same WARP setup, ffmpeg pipeline, and conventions.

## What it does

- **Any station, not just lofi.** 20 built-in stations plus live search across
  ~50,000 real radio stations via [radio-browser.info](https://www.radio-browser.info)
  (free, no API key).
- **Real now-playing.** Reads the current track straight off the Icecast/SHOUTcast
  protocol — `lofi np` shows the actual song.
- **Survives everything.** Stall watchdog, exponential backoff, automatic fallback to a
  second station, voice auto-rejoin, and state persistence so a restart puts every
  server back on the air by itself.
- **YouTube live works too** (Lofi Girl etc.), through the same WARP proxy the music bot uses.

## Setup

```bash
git clone <this repo> ~/lofi-radio-bot && cd ~/lofi-radio-bot
npm install
cp .env.example .env      # fill in DISCORD_TOKEN
node bot.js
```

Requires **Node 18+**, **ffmpeg**, and (only for YouTube stations) **yt-dlp**.
You already have all three from the music bot — point `.env` at the same binaries.

In the Discord developer portal, enable the **Message Content Intent** (for the `lofi`
prefix) and invite the bot with the `Connect` + `Speak` voice permissions.

### Run it as a service

```bash
cp lofi-radio.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now lofi-radio
sudo loginctl enable-linger $USER      # survives logout
journalctl --user -u lofi-radio -f     # logs
```

## Commands

Prefix (`lofi` by default) or `/radio`.

| Command | What it does |
|---|---|
| `lofi play` | Start the default station |
| `lofi play <id \| name \| URL>` | Play a specific station, or any stream URL |
| `lofi search <query>` | Search ~50,000 stations, pick from a menu |
| `lofi stations` | List the built-ins |
| `lofi np` | Now playing panel |
| `lofi volume 50` | 0–200% |
| `lofi random` | Surprise station |
| `lofi stop` | Go off air and leave |

Search accepts filters: `lofi search jazz country:JP`, `lofi search tag:lofi`.

## How it stays up 24/7

The bot logic is easy; keeping it alive is the actual work. Five layers, each catching
what the one above it misses:

1. **ffmpeg reconnects** (`-reconnect_on_network_error`) — handles ordinary blips and 5xx.
2. **Stall watchdog** — a radio stream never legitimately ends, so *silence is a fault*.
   No audio bytes for 25s → tear the chain down and rebuild.
3. **Dead-connection watchdog** — the nasty one. Audio can flow perfectly while the voice
   connection never reached `Ready`, so every packet is discarded and the channel is
   silent while every other health signal looks green. Not `Ready` for 60s → full restart.
4. **Backoff + fallback** — retries back off to 30s; after 4 consecutive failures it
   switches to `FALLBACK_STATION` so the channel keeps playing *something* instead of
   going quiet at 3am.
5. **State persistence + resume sweep** — every guild's channel and station are saved
   atomically. On boot, and again every 5 minutes, anything that should be on air and
   isn't gets put back.

`Restart=always` in the systemd unit covers the last case: the process itself dying.

## Notes from building it

**ffmpeg will not give you ICY titles.** The common advice is to parse
`Metadata update for StreamTitle` out of ffmpeg's stderr. I measured this against SomaFM
on ffmpeg 8.1.2 at `-loglevel info` for 260 seconds, spanning a track change: **zero such
lines**. So `stations.js` speaks the ICY protocol directly instead — request with
`Icy-MetaData: 1`, read `icy-metaint` bytes, parse the metadata block, hang up. ~16KB per
poll, every 30s, and it works on every Icecast/SHOUTcast server. Verified live:

```
OK  SomaFM Groove Salad   1290ms  Smooth Genestar - Rem Phase
OK  SomaFM Fluid          1327ms  ideism - switch-up
OK  Radio Paradise         111ms  Rock Berg - Let Go!
```

**YouTube live is piped through yt-dlp, not resolved to a URL.** Handing ffmpeg a
resolved `.m3u8` works for a few hours and then dies, because YouTube's manifest URLs
expire. Streaming `yt-dlp -o -` into ffmpeg lets yt-dlp refresh the manifest internally,
so the stream just keeps going. A bot-check on the yt-dlp side triggers the same
`rotateWarp()` the music bot uses.

**Icecast servers burst on connect.** Expect ~4 seconds of data arriving at ~4x realtime
when a stream starts, then it locks to exactly 50 Opus packets/sec (Discord's 20ms frame
rate). Measured:

```
t= 5s  +950 packets = 190.0/s     <- connect burst
t=10s  +250 packets =  50.0/s     <- steady state
t=35s  +250 packets =  50.0/s
```

Backpressure handles it; nothing to tune.

**`@discordjs/opus` is not needed.** ffmpeg already emits Ogg/Opus and we hand it over as
`StreamType.OggOpus`, so `@discordjs/voice` never encodes anything — it only demuxes.
Dropping it also drops a native build that fails on Node 24. `sodium-native` is optional
for the same reason (`@noble/ciphers` is the pure-JS fallback).

**Don't rename the voice channel per track.** Channel renames are rate-limited to roughly
2 per 10 minutes and will silently stall. The now-playing panel is an edited message
instead, which is far cheaper.

## Config

| Variable | Default | Notes |
|---|---|---|
| `DISCORD_TOKEN` | — | required |
| `PREFIX` | `lofi` | text command prefix |
| `DEFAULT_STATION` | `lofigirl` | played by a bare `lofi play` |
| `FALLBACK_STATION` | `somafm-fluid` | used when the primary keeps failing |
| `YT_DLP_PROXY` | `socks5://127.0.0.1:40000` | WARP proxy; empty = direct |
| `STREAM_RECYCLE_HOURS` | `12` | periodic chain rebuild; `0` disables |
| `PAUSE_WHEN_EMPTY` | off | cut the stream when nobody's listening |
| `GUILD_ID` | — | register slash commands instantly to one guild |
| `FFMPEG_PATH` / `YT_DLP_PATH` | `~/bin/...` | same binaries as the music bot |

## Resource use

Roughly 1GB/day of bandwidth per active server (96kbps Opus) and very little CPU —
ffmpeg is transcoding one low-bitrate stream. A €4/mo VPS handles many servers at once.
Set `PAUSE_WHEN_EMPTY=1` to cut both to zero while nobody is in the channel.

Each guild gets its own ffmpeg process, so two servers on the same station are two
independent streams slightly out of sync. Truly synchronised broadcast would need one
encoder fanned out to every guild — doable, but Ogg framing makes late joiners awkward,
and it isn't worth the complexity unless you're on a lot of servers.
