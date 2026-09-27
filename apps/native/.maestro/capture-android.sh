#!/usr/bin/env bash
# Runs inside reactivecircus/android-emulator-runner (emulator already booted).
#
# Usage: capture-android.sh <apk> <out-dir> <WxH> <density>
#   Size/density are forced with `wm` so the capture matches the Play form
#   factor exactly, independent of the AVD profile's own panel.
set -euo pipefail

apk="$1" out="$2" size="$3" density="$4"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$out"

# `ping` never works in the emulator (no ICMP passthrough) and there's no
# curl on the image -- Android's own connectivity check (VALIDATED) is the
# reliable signal that the guest really reaches the internet.
for i in $(seq 1 60); do
  if adb shell dumpsys connectivity | grep -q 'Capabilities:.*INTERNET.*VALIDATED'; then
    echo "emulator network validated"
    break
  fi
  if [ "$i" = 60 ]; then
    echo "::error::emulator has no validated internet connection"
    exit 1
  fi
  sleep 2
done

adb shell wm size "$size"
adb shell wm density "$density"

# Clean, deterministic status bar (SystemUI demo mode).
adb shell settings put global sysui_demo_allowed 1
demo() { adb shell am broadcast -a com.android.systemui.demo -e command "$@" >/dev/null; }
demo enter
demo clock -e hhmm 0941
demo battery -e level 100 -e plugged false
demo network -e wifi show -e level 4
demo network -e mobile show -e datatype none -e level 4
demo notifications -e visible false

adb install -r "$apk"

maestro test -e OUT="$out" "$here/screenshots.yaml"

# Fail loudly on a wrong-size capture rather than upload unusable images.
want="${size/x/ x }"
for f in "$out"/*.png; do
  file "$f" | grep -q "$want" || { echo "::error::$f is not $size: $(file -b "$f")"; exit 1; }
done
ls -l "$out"
