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

exit "$status"
