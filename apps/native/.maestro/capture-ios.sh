#!/usr/bin/env bash
# Boots the App Store's required simulator sizes on a macOS runner and runs
# the shared Maestro flow on each.
#
# Usage: capture-ios.sh <path/to/App.app> <out-root>
#   Writes <out-root>/iphone-6.9/*.png (1320x2868) and
#          <out-root>/ipad-13/*.png    (2064x2752)
set -euo pipefail

app="$1" out_root="$2"
here="$(cd "$(dirname "$0")" && pwd)"

runtime=$(xcrun simctl list runtimes -j \
  | jq -r '[.runtimes[] | select(.platform == "iOS" and .isAvailable)] | sort_by(.version | split(".") | map(tonumber)) | last | .identifier')
[ -n "$runtime" ] && [ "$runtime" != null ] || { echo "::error::no iOS simulator runtime on runner"; exit 1; }

device_type() {
  xcrun simctl list devicetypes -j \
    | jq -r --arg re "$1" '[.devicetypes[] | select(.name | test($re))] | sort_by(.name) | last | .identifier'
}

# name | device-type regex | expected WxH
# Read on fd 3: maestro/simctl would otherwise consume the heredoc via stdin.
while IFS='|' read -r name re size <&3; do
  type=$(device_type "$re")
  [ -n "$type" ] && [ "$type" != null ] || { echo "::error::no simulator type matching $re"; exit 1; }
  echo "== $name: $type on $runtime"

  udid=$(xcrun simctl create "shots-$name" "$type" "$runtime")
  xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" -b
  xcrun simctl status_bar "$udid" override \
    --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 \
    --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
  xcrun simctl install "$udid" "$app"

  out="$out_root/$name"
  mkdir -p "$out"
  bash "$here/run-flow.sh" "$out" --device "$udid"

  want="${size/x/ x }"
  for f in "$out"/*.png; do
    file "$f" | grep -q "$want" || { echo "::error::$f is not $size: $(file -b "$f")"; exit 1; }
  done
  ls -l "$out"

  xcrun simctl shutdown "$udid"
  xcrun simctl delete "$udid"
done 3<<'EOF'
iphone-6.9|^iPhone [0-9]+ Pro Max$|1320x2868
ipad-13|^iPad Pro 13-inch|2064x2752
EOF
