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

status=0
maestro "$@" test --test-output-dir="$raw" "$here/screenshots.yaml" || status=$?

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

exit "$status"
