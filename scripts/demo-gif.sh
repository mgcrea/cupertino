#!/usr/bin/env bash
#
# Turn a screen recording of Cupertino into a GIF small enough for a README.
#
# The recording is yours to make: capturing the app needs Screen Recording,
# and `make screenshots-doctor` reports whether the grant is in place. This
# script only does the part that is deterministic — the encode.
#
#   scripts/demo-gif.sh recording.mov [out.gif]
#   WIDTH=1000 FPS=12 scripts/demo-gif.sh recording.mov
#
# ## Why two passes
#
# A GIF holds 256 colours. ffmpeg's default picks them per frame, which makes
# a UI recording shimmer — the window chrome changes colour between frames on
# flat grey. `palettegen` computes ONE palette across the whole clip and
# `paletteuse` applies it, which is both smaller and stable. `stats_mode=diff`
# weights the palette toward pixels that actually change, so the palette is
# spent on the text and the log rows rather than on the desktop behind them.
#
# `bayer` dithering rather than the default `sierra2_4a`: error-diffusion
# dithers re-randomise between frames on flat fills, and every changed pixel
# costs bytes in a GIF. Bayer is a fixed pattern, so an unchanged region stays
# byte-identical frame to frame and compresses away. On a screen recording it
# is usually 30-50% smaller for no visible loss.
set -euo pipefail

cd "$(dirname "$0")/.."

SRC="${1:?usage: scripts/demo-gif.sh recording.mov [out.gif]}"
OUT="${2:-design/cupertino-demo.gif}"
WIDTH="${WIDTH:-1000}"
FPS="${FPS:-12}"
BAYER_SCALE="${BAYER_SCALE:-3}"

[ -f "$SRC" ] || { echo "no such recording: $SRC" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is not installed (brew install ffmpeg)" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
# `mktemp -d` rather than `mktemp -t <prefix>`: the -t form means different
# things to BSD and GNU mktemp, and a Mac with coreutils on PATH gets the GNU
# one, which rejects a template with no X's.
TMPDIR_GIF="$(mktemp -d)"
PALETTE="$TMPDIR_GIF/palette.png"
trap 'rm -rf "$TMPDIR_GIF"' EXIT

FILTER="fps=${FPS},scale=${WIDTH}:-1:flags=lanczos"

echo "→ pass 1/2  palette across the whole clip"
ffmpeg -v error -y -i "$SRC" -vf "${FILTER},palettegen=stats_mode=diff" "$PALETTE"

echo "→ pass 2/2  encode at ${WIDTH}px ${FPS}fps"
ffmpeg -v error -y -i "$SRC" -i "$PALETTE" \
  -lavfi "${FILTER}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=${BAYER_SCALE}:diff_mode=rectangle" \
  -loop 0 "$OUT"

BYTES=$(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT")
MB=$(echo "scale=1; $BYTES/1048576" | bc)
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SRC" | cut -d. -f1)
echo
echo "  $OUT — ${MB} MB, ${DUR}s source, ${WIDTH}px, ${FPS}fps"

# GitHub renders a README GIF up to 10 MB but stops animating much sooner on
# slow connections, and HN readers arrive on mobile. 5 MB is the practical bar.
if [ "$BYTES" -gt 5242880 ]; then
  echo
  echo "  ⚠ over 5 MB. In order of what costs least visually:" >&2
  [ "$FPS" -gt 10 ] && echo "     FPS=10 scripts/demo-gif.sh $SRC" >&2
  [ "$WIDTH" -gt 800 ] && echo "     WIDTH=800 scripts/demo-gif.sh $SRC" >&2
  echo "     trim the source — every second of idle UI is pure cost" >&2
  exit 2
fi
