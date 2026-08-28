#!/usr/bin/env bash
# Proves the WARP-bridged YouTube-live pipeline produces sustained Ogg/Opus.
# Run as the lonelyslack user (same user as lofi-radio.service).
#
#   chmod +x verify-lofi-warp.sh && ./verify-lofi-warp.sh
#
# Override via env: PROXY, YTDLP, FFMPEG, URL, SECS

set -uo pipefail

PROXY="${PROXY:-http://127.0.0.1:8118}"
YTDLP="${YTDLP:-$HOME/bin/yt-dlp}"
FFMPEG="${FFMPEG:-/usr/bin/ffmpeg}"
URL="${URL:-https://www.youtube.com/@LofiGirl/live}"
SECS="${SECS:-60}"
OUT="${OUT:-/tmp/lofi-verify.ogg}"

fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }
hr()   { printf '\n== %s ==\n' "$*"; }

hr "1. bridge is up and egresses via WARP"
BRIDGED=$(curl -fsS -x "$PROXY" --max-time 20 \
          https://www.cloudflare.com/cdn-cgi/trace) \
  || fail "no answer through $PROXY - is privoxy/gost running?"
echo "$BRIDGED" | grep -E '^(ip|warp)='

hr "2. direct egress, for contrast"
DIRECT=$(curl -fsS --max-time 20 https://www.cloudflare.com/cdn-cgi/trace) \
  || fail "no direct egress"
echo "$DIRECT" | grep -E '^(ip|warp)='

BIP=$(echo "$BRIDGED" | sed -n 's/^ip=//p')
DIP=$(echo "$DIRECT"  | sed -n 's/^ip=//p')
[ -n "$BIP" ] && [ "$BIP" != "$DIP" ] \
  || fail "bridged IP ($BIP) == direct IP ($DIP); traffic is NOT going through WARP"
echo "ok: bridged $BIP != direct $DIP"

hr "3. resolve manifest through the bridge"
M3U8=$("$YTDLP" --js-runtimes node --proxy "$PROXY" \
        -f 'ba[protocol^=m3u8]/ba/b' -g "$URL") \
  || fail "yt-dlp could not resolve $URL"
M3U8=$(printf '%s\n' "$M3U8" | head -n1)
[ -n "$M3U8" ] || fail "empty manifest URL"
echo "manifest: ${M3U8:0:90}..."

hr "4. ${SECS}s capture, ffmpeg using the same bridge"
rm -f "$OUT"
timeout $((SECS + 45)) "$FFMPEG" -hide_banner -loglevel warning \
  -http_proxy "$PROXY" \
  -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
  -rw_timeout 15000000 \
  -i "$M3U8" \
  -vn -c:a libopus -ar 48000 -ac 2 -b:a 96k -vbr on -application audio \
  -t "$SECS" -f ogg "$OUT" \
  || fail "ffmpeg exited nonzero (see warnings above)"

hr "5. verify the bytes"
[ -s "$OUT" ] || fail "no bytes captured"

MAGIC=$(head -c4 "$OUT" | xxd -p)
[ "$MAGIC" = "4f676753" ] || fail "first 4 bytes are 0x$MAGIC, not OggS (4f676753)"

PAGES=$(grep -abo OggS "$OUT" | wc -l)
PKTS=$(ffprobe -v error -select_streams a:0 -count_packets \
       -show_entries stream=nb_read_packets -of csv=p=0 "$OUT")
BYTES=$(stat -c%s "$OUT")
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")
STREAM=$(ffprobe -v error -select_streams a:0 \
         -show_entries stream=codec_name,sample_rate,channels -of csv=p=0 "$OUT")

echo "magic     : OggS"
echo "bytes     : $BYTES"
echo "OggS pages: $PAGES"
echo "packets   : $PKTS"
echo "duration  : ${DUR}s"
echo "stream    : $STREAM"

case "$STREAM" in opus,48000,2) ;; *) fail "expected opus,48000,2 got $STREAM" ;; esac
MINPKT=$(awk -v s="$SECS" 'BEGIN { printf "%d", s * 50 * 0.9 }')
[ "$PKTS" -ge "$MINPKT" ] \
  || fail "only $PKTS Opus packets, expected >= $MINPKT (~50/s) - stream stalled"
awk -v d="$DUR" -v s="$SECS" 'BEGIN { exit !(d >= s * 0.98) }' \
  || fail "duration $DUR is short of ${SECS}s - stream did not sustain"

printf '\nPASS: %ss of valid Ogg/Opus sustained through WARP.\n' "$SECS"
