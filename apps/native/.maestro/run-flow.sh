#!/usr/bin/env bash
# Runs screenshots.yaml and collects its takeScreenshot PNGs into <out-dir>.
#
# Usage: run-flow.sh <out-dir> [extra maestro args, e.g. --device <udid>]
#
# Maestro confines takeScreenshot paths to its own per-run artifact folder
# (<test-output-dir>/<session>/<flow>/takeScreenshot/) and rejects paths that
# resolve anywhere else, so the flow uses bare file names and this script
# copies them out. The rest of that folder (commands.json, logs) records
# typed text, including the test OTP -- it lives in a private temp dir that
# is deleted afterwards, never under <out-dir>.
#
# Store shots land in <out-dir>/*.png; debug shots (names starting with `_`)
# in <out-dir>/debug/ so they're kept for diagnosis but never mistaken for a
# store upload or size-checked. PNGs are collected even when the flow fails.
set -euo pipefail

out="$1"; shift
here="$(cd "$(dirname "$0")" && pwd)"
raw="$(mktemp -d)"
trap 'rm -rf "$raw"' EXIT
mkdir -p "$out"

# Crash reports newer than this belong to this run (see the end).
touch "$raw/.started"

# iPhone Duo (capture-ios.sh): Maestro only drives the COVER display (its taps
# land there whatever the posture), so the flow runs folded and pauses after
# every shot (duo-pause.yaml). While it waits, this watcher unfolds the device,
# captures the inner display with `duoctl` (https://github.com/skarol/duoctl,
# since simctl has no fold command), and folds it again, so the inner-display
# shot shows exactly the same app state, after a live fold/unfold resize.
# duoctl sweeps the hinge (a jump wedges the iOS 27.1 simulator) and waits for
# the other display to take over, so no fixed sleeps are needed around it; the
# cover's portrait is the inner display's landscape, hence the rotate.
# Enabled by DUO_INNER_OUT=<dir>; DUOCTL_UDID must name the simulator.
export MAESTRO_DUO="${MAESTRO_DUO:-0}"
watcher=""
if [ -n "${DUO_INNER_OUT:-}" ]; then
  export MAESTRO_DUO=1
  mkdir -p "$DUO_INNER_OUT"
  (
    seen=" "
    while [ ! -e "$raw/.flow-done" ]; do
      while IFS= read -r -d '' f; do
        n="$(basename "$f" .png)"
        case "$n" in _*) continue ;; esac
        case "$seen" in *" $n "*) continue ;; esac
        seen="$seen$n "
        sleep 1                                   # let Maestro finish writing the PNG
        t0=$(date +%s)
        if duoctl open && { duoctl rotate portrait || echo "::warning::inner display stayed landscape for $n"; } \
            && sleep 1 && duoctl screenshot "$DUO_INNER_OUT/$n.png"; then :
        else echo "::warning::inner-display capture of $n failed"; duoctl state || true; fi
        duoctl close || { echo "::error::could not fold the Duo back: Maestro's next taps will miss"; duoctl state || true; }
        sleep 1
        el=$(( $(date +%s) - t0 ))
        echo "duo inner capture of $n took ${el}s (flow pauses 30s)"
        [ "$el" -lt 28 ] || echo "::warning::inner capture of $n took ${el}s, close to the flow's 30 s pause: Maestro may resume while unfolded"
      done < <(find "$raw" -path '*/takeScreenshot/*' -name '*.png' -print0 2>/dev/null)
      sleep 1
    done
  ) &
  watcher=$!
fi

status=0
maestro "$@" test --test-output-dir="$raw" "$here/screenshots.yaml" || status=$?
touch "$raw/.flow-done"
[ -z "$watcher" ] || wait "$watcher" || true

while IFS= read -r -d '' f; do
  case "$(basename "$f")" in
    _*) mkdir -p "$out/debug"; cp "$f" "$out/debug/" ;;
    *)  cp "$f" "$out/" ;;
  esac
done < <(find "$raw" -path '*/takeScreenshot/*' -name '*.png' -print0)

# Maestro's own screenshot of the failing step (screenshots/), so a failure
# before any takeScreenshot still leaves an image. Skipped when the failed
# step belongs to the login flow: from the OTP step onwards the screen shows
# the test OTP in clear text. Anything outside login.yaml (the wait before
# it, everything after sign-in) never has the OTP on screen.
# Fails safe: copies only when commands.json exists and jq positively says
# no failed step touched login (exit 1); a jq error or missing file skips.
login_failed() {
  local cmds rc=1
  cmds=$(find "$raw" -name commands.json | head -n1)
  [ -n "$cmds" ] || return 0
  jq -e '[.. | objects
          | select((.status? // "" | tostring) | test("fail"; "i"))
          | tostring
          | select(test("login[.]yaml|login-otp|login-verify-otp|login-error"))]
         | length > 0' "$cmds" >/dev/null 2>&1 || rc=$?
  [ "$rc" = 1 ] && return 1
  return 0
}
if [ "$status" != 0 ]; then
  if login_failed; then
    echo "Not keeping Maestro's failure screenshot: failure was in the login flow (screen would show the test OTP)."
  else
    while IFS= read -r -d '' f; do
      mkdir -p "$out/debug"; cp "$f" "$out/debug/"
    done < <(find "$raw" -path '*/screenshots/*' -name '*.png' -print0)
  fi
fi

# On a non-login failure, dump the live accessibility tree so an "Element not
# found" can be diagnosed (missing element, or just mis-identified?). Skipped
# for login failures: the OTP is on screen then.
if [ "$status" != 0 ] && ! login_failed; then
  mkdir -p "$out/debug"
  maestro "$@" hierarchy > "$out/debug/hierarchy.json" 2>&1 || true
  # Also list the ids and labels in the job log (never run for login failures,
  # where the OTP is on screen), so a missing element is diagnosable without
  # downloading the artifact.
  echo "--- accessibility ids / labels on screen at the failure ---"
  grep -oE '"(accessibilityText|resource-id|text)" *: *"[^"]+"' "$out/debug/hierarchy.json" | sort -u | head -80 || true
  # Where Maestro thinks the app's own elements are (bounds), to check the
  # driver's coordinate space on the iPhone Duo against the screenshot.
  echo "--- bounds of identified elements ---"
  python3 - "$out/debug/hierarchy.json" <<'PY' || true
import json, sys
try:
    tree = json.load(open(sys.argv[1]))
except Exception as e:
    print("unreadable hierarchy:", e); sys.exit(0)
def walk(n):
    a = n.get("attributes", {}) if isinstance(n, dict) else {}
    rid = a.get("resource-id") or ""
    if rid and not rid.startswith(("cc-", "bolt", "Page", "wifi")):
        print(f"{rid:32} bounds={a.get('bounds')}")
    for c in (n.get("children") or []) if isinstance(n, dict) else []:
        walk(c)
walk(tree)
PY
  # iOS simulator: when the hierarchy is SpringBoard (the app is gone), the
  # simulator's own log says why -- crash, jetsam, watchdog, or a launch that
  # never happened. Filtered to our process and SpringBoard's app lifecycle
  # lines; the OTP is never on this path (login failures are excluded above).
  udid=""
  for ((i = 1; i <= $#; i++)); do [ "${!i}" = "--device" ] && { j=$((i + 1)); udid="${!j}"; }; done
  if [ -n "$udid" ] && command -v xcrun >/dev/null; then
    echo "--- simulator log (last 10 min, OpenVFR process / app lifecycle) ---"
    xcrun simctl spawn "$udid" log show --last 10m --style compact \
      --predicate 'process == "OpenVFR" OR process CONTAINS "maestro" OR process CONTAINS "iosUITests" OR eventMessage CONTAINS "org.openvfr.app" OR (process == "SpringBoard" AND (eventMessage CONTAINS "exit" OR eventMessage CONTAINS "terminat" OR eventMessage CONTAINS "crash"))' \
      2>/dev/null | grep -viE "^\s*$|compose failure" > "$out/debug/simulator-log.txt" || true
    # Maestro's XCTest driver decides which app's hierarchy to return from
    # XCUIApplication.activeAppsInfo() + state == runningForeground; on the
    # iPhone Duo (run 41651367223) it returned SpringBoard while OpenVFR was
    # the foreground, focal app. Its own log lines show what it saw.
    grep -E "Detected running apps|No foreground app|View hierarchy snapshot|Process exited|Calculated state for app<org.openvfr" "$out/debug/simulator-log.txt" | tail -40 || true
    echo "(full filtered log: debug/simulator-log.txt, $(wc -l < "$out/debug/simulator-log.txt") lines)"
    # The display Maestro should be looking at, as pixels.
    if [ -n "${DUOCTL_UDID:-}" ]; then duoctl state || true; duoctl screenshot "$out/debug/_duo-at-failure.png" || true; fi
    # Crash reports written inside the simulator (not only the host's folder).
    simdir=$(xcrun simctl list devices -j | python3 -c "import sys,json;d=[x for r in json.load(sys.stdin)['devices'].values() for x in r if x['udid']=='$udid'];print(d[0]['dataPath'] if d else '')" 2>/dev/null)
    if [ -n "$simdir" ]; then
      find "$simdir/Library/Logs" "$HOME/Library/Logs/DiagnosticReports" -maxdepth 3 \( -name 'OpenVFR*.ips' -o -name 'OpenVFR*.crash' \) -newer "$raw/.started" 2>/dev/null | while read -r f; do
        mkdir -p "$out/debug"; cp "$f" "$out/debug/"
        echo "::error::app crashed during the flow -- $out/debug/$(basename "$f")"; head -c 3000 "$f"; echo
      done
    fi
  fi
fi

# Maestro writes logs/crash-report.txt only when the app under test crashed:
# a logcat stack trace (Android) or the simulator's .ips report (iOS). It
# holds no typed text, unlike the rest of the folder, so keep it and print
# its head so the job log shows the crash without downloading the artifact.
while IFS= read -r -d '' f; do
  mkdir -p "$out/debug"
  cp "$f" "$out/debug/crash-report.txt"
  echo "::error::app crashed during the flow -- $out/debug/crash-report.txt"
  head -c 4000 "$f"; echo
done < <(find "$raw" -path '*/logs/*' -name 'crash-report.txt' -print0)

# iOS simulator: Maestro does not always notice the app died (the flow just
# fails on the next assertion, with the home screen showing). The simulator
# writes the app's crash report to the host's DiagnosticReports; keep the
# ones written during this flow. Like crash-report.txt they hold stacks, not
# typed text.
if [ "$status" != 0 ] && [ -d "$HOME/Library/Logs/DiagnosticReports" ]; then
  while IFS= read -r -d '' f; do
    mkdir -p "$out/debug"
    cp "$f" "$out/debug/"
    echo "::error::app crashed during the flow -- $out/debug/$(basename "$f")"
    head -c 4000 "$f"; echo
  done < <(find "$HOME/Library/Logs/DiagnosticReports" -maxdepth 1 -name 'OpenVFR*.ips' -newer "$raw/.started" -print0)
fi

exit "$status"
