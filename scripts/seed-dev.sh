#!/bin/sh
# Fills dev-data/media/photos with generated pictures and 3-second clips, for `npm run dev:server`. Needs ffmpeg.
# It does nothing when the folder is already there: delete dev-data/media/photos to start over.
set -eu
cd "$(dirname "$0")/.."
root=dev-data/media/photos

command -v ffmpeg >/dev/null || { echo "seed: ffmpeg is needed" >&2; exit 1; }
if [ -d "$root" ]; then echo "seed: $root exists already, nothing to do"; exit 0; fi

# photo <folder> <file name> <seconds into the pattern> <testsrc|mandelbrot>: one 1600x1200 frame, a different one for each time offset
photo() { ffmpeg -nostdin -v error -y -f lavfi -i "$4=size=1600x1200:rate=1" -ss "$3" -frames:v 1 -q:v 3 "$1/$2"; }
# video <folder> <file name> <testsrc|mandelbrot>
video() { ffmpeg -nostdin -v error -y -f lavfi -i "$3=size=1280x720:rate=25" -t 3 -c:v libx264 -pix_fmt yuv420p "$1/$2"; }

# fill <folder> <photos> <videos> <first number>: IMG_<number>.jpg every third number, the clips after them
fill() {
  mkdir -p "$1"
  i=0
  while [ "$i" -lt "$2" ]; do
    if [ $((i % 2)) -eq 0 ]; then src=testsrc; else src=mandelbrot; fi
    photo "$1" "IMG_$(($4 + i * 3)).jpg" $((i + 1)) "$src"
    i=$((i + 1))
  done
  i=0
  while [ "$i" -lt "$3" ]; do
    if [ $((i % 2)) -eq 0 ]; then src=mandelbrot; else src=testsrc; fi
    video "$1" "VID_$(($4 + ($2 + i) * 3)).mp4" "$src"
    i=$((i + 1))
  done
}

fill "$root/Travel/Iceland 2026" 18 2 3101
fill "$root/Travel/Lisbon 2025" 12 1 1820
fill "$root/Family/Birthdays" 9 1 1402
fill "$root/Family/Summer house" 14 2 1530
fill "$root/Camera roll" 20 2 5012
echo "Not a photo or a video, so the gallery never lists it." > "$root/Family/notes.txt"

# a name with Cyrillic, a space, a # and a %: all of it has to survive an address, a download and a zip
fill "$root/Дача #2 (2024)" 6 1 101
mv "$root/Дача #2 (2024)/IMG_101.jpg" "$root/Дача #2 (2024)/IMG 50%.jpg"
echo "seed: done, in $root"
