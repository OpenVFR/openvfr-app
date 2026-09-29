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

# Hosted emulators are slow enough that system apps (launcher, gms) regularly
# trip an ANR. The "<app> isn't responding" dialog is a system window on top
# of our app: Maestro then cannot see any of our elements and every flow
# times out at the first assertion. Suppress those dialogs, and dismiss any
# that is already showing.
adb shell settings put global hide_error_dialogs 1
adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1 || true

adb shell wm size "$size"
adb shell wm density "$density"

# Clean, deterministic status bar (SystemUI demo mode).
adb shell settings put global sysui_demo_allowed 1
demo() { adb shell am broadcast -a com.android.systemui.demo -e command "$@" >/dev/null; }
demo enter
demo clock -e hhmm 0941
demo battery -e level 100 -e plugged false
demo network -e wifi show -e level 4 -e fully true
demo network -e mobile show -e datatype none -e level 4
demo notifications -e visible false

adb install -r "$apk"

adb logcat -c
status=0
bash "$here/run-flow.sh" "$out" || status=$?

# Keep a filtered logcat for diagnosis: MapLibre/PMTiles lines (map sources
# that fail to load leave no trace in the screenshots, just missing detail)
# plus why the app process died (Java crash, native crash, low-memory kill,
# OOM). Filtered by pattern -- the full logcat, which can include the app's
# own JS log output, is never uploaded.
mkdir -p "$out/debug"
keep='mbgl|maplibre|pmtiles|AndroidRuntime|FATAL EXCEPTION|OutOfMemory'
keep+='|lowmemorykiller|lmkd|has died|Process org[.]openvfr[.]app'
keep+='|ActivityManager: (Start proc|Killing).*openvfr'
adb logcat -d -v time 2>/dev/null \
  | grep -E -i "$keep" \
  | grep -v 'Could not find generated setter' \
  > "$out/debug/app-logcat.txt" || true
echo "Filtered logcat lines: $(wc -l < "$out/debug/app-logcat.txt")"
grep -E ' [EWF]/' "$out/debug/app-logcat.txt" | head -60 || true
[ "$status" = 0 ] || exit "$status"

# Fail loudly on a wrong-size capture rather than upload unusable images.
want="${size/x/ x }"
for f in "$out"/*.png; do
  file "$f" | grep -q "$want" || { echo "::error::$f is not $size: $(file -b "$f")"; exit 1; }
done
ls -l "$out"
