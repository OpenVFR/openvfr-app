#!/usr/bin/env bash
# Boots the simulators the App Store listing needs on a macOS runner and runs
# the shared Maestro flow on each.
#
# Usage: capture-ios.sh <path/to/App.app> <out-root>
#   Writes <out-root>/iphone-6.3/*.png     (1206x2622; one iPhone size is enough:
#                                           Apple scales it down for the other iPhones)
#          <out-root>/ipad-13/*.png        (2064x2752)
#          <out-root>/iphone-duo-cover/*.png (1398x2034, folded, outer display)
#          <out-root>/iphone-duo-inner/*.png (2007x2853, unfolded, inner display)
#   (App Store Connect also takes 1179x2556 for 6.1" and 2622x1206-style
#   landscape sizes; the sizes above are the ones this script verifies.)
#
# The Duo needs Xcode 27.1 and its iOS 27.1 runtime; on a runner without it
# the Duo step is skipped with a warning unless REQUIRE_DUO=1.
set -euo pipefail

app="$1" out_root="$2"
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=duo-lib.sh
. "$here/duo-lib.sh"

device_type() {
  xcrun simctl list devicetypes -j \
    | jq -r --arg re "$1" '[.devicetypes[] | select(.name | test($re))] | sort_by(.name) | last | .identifier'
}

# Newest available runtime that supports the device type ("iOS 27.1 only
# supports iPhone Duo" on the Xcode 27 runner image, so one global "latest
# runtime" cannot be used for every device).
runtime_for() {
  xcrun simctl list runtimes -j \
    | jq -r --arg t "$1" '[.runtimes[] | select(.platform == "iOS" and .isAvailable and ((.supportedDeviceTypes // []) | map(.identifier) | index($t)))]
        | sort_by(.version | split(".") | map(tonumber)) | last | .identifier'
}

status_bar() {
  xcrun simctl status_bar "$1" override \
    --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 \
    --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100 || \
    echo "::warning::status_bar override failed (not supported on this device)"
}

# check_sizes <dir> <WxH> [<WxH>...]: every PNG must be one of the sizes.
check_sizes() {
  local dir="$1"; shift
  local f ok w
  for f in "$dir"/*.png; do
    ok=0
    for w in "$@"; do file "$f" | grep -q "${w/x/ x }" && ok=1; done
    [ "$ok" = 1 ] || { echo "::error::$f is none of $*: $(file -b "$f")"; return 1; }
  done
}

# run_flow <out> <udid> [duo]: run-flow.sh with Maestro's stock driver, or,
# for the Duo when the workflow built one (MAESTRO_DUO_XCTESTRUN), with the
# patched XCTest driver: started here with `xcodebuild test-without-building`
# on a fixed port, Maestro told to use it (USE_XCODE_TEST_RUNNER) instead of
# installing its own. The runner is started just after Maestro checks the
# port is free and before it starts waiting for it (up to 120 s), then killed
# when the flow ends. TEST_RUNNER_* variables reach the runner without the
# prefix; MAESTRO_FOREGROUND_APP is the patch's foreground-app fallback.
run_flow() {
  local out="$1" udid="$2" duo="${3:-}" port=22087 status=0 runner=""
  if [ -z "$duo" ] || [ -z "${MAESTRO_DUO_XCTESTRUN:-}" ]; then
    bash "$here/run-flow.sh" "$out" --device "$udid"
    return
  fi
  mkdir -p "$out/debug"
  (
    sleep 2
    TEST_RUNNER_PORT=$port TEST_RUNNER_MAESTRO_FOREGROUND_APP=org.openvfr.app \
      xcodebuild test-without-building -xctestrun "$MAESTRO_DUO_XCTESTRUN" \
        -destination "id=$udid" -derivedDataPath "$(mktemp -d)" \
        > "$out/debug/patched-driver-xcodebuild.log" 2>&1
  ) &
  runner=$!
  USE_XCODE_TEST_RUNNER=1 bash "$here/run-flow.sh" "$out" --device "$udid" --driver-host-port "$port" || status=$?
  kill "$runner" 2>/dev/null || true
  pkill -f "test-without-building -xctestrun $MAESTRO_DUO_XCTESTRUN" 2>/dev/null || true
  xcrun simctl terminate "$udid" dev.mobile.maestro-driver-iosUITests.xctrunner 2>/dev/null || true
  # The patched driver's own decisions (NSLog goes to the xcodebuild output).
  echo "--- patched driver: foreground-app decisions (message, count) ---"
  grep -E "Foreground app hint|Foreground app fallback|Detected running apps|Kept serving|No foreground app found|Adjusting view hierarchy|Skipping offset|Rotating app frames|Screen size: app frame|Snapshot failure|App orientation is" "$out/debug/patched-driver-xcodebuild.log" \
    | sed -E 's/^.*Runner\[[0-9:]+\] //' | sort | uniq -c | sort -rn | head -15 || true
  return "$status"
}

capture() { # name regex sizes(space separated) [duo]
  local name="$1" re="$2" sizes="$3" duo="${4:-}"
  local type runtime udid out
  type=$(device_type "$re")
  if [ -z "$type" ] || [ "$type" = null ]; then
    if [ -n "$duo" ] && [ "${REQUIRE_DUO:-0}" != 1 ]; then echo "::warning::no simulator type matching $re (needs Xcode 27.1); skipping $name"; return 0; fi
    echo "::error::no simulator type matching $re"; return 1
  fi
  runtime=$(runtime_for "$type")
  if [ -z "$runtime" ] || [ "$runtime" = null ]; then
    if [ -n "$duo" ] && [ "${REQUIRE_DUO:-0}" != 1 ]; then echo "::warning::no iOS runtime supports $type; skipping $name"; return 0; fi
    echo "::error::no iOS runtime supports $type"; return 1
  fi
  echo "== $name: $type on $runtime"

  # Free the previous device's RAM/CPU before booting the next one.
  xcrun simctl shutdown all || true
  udid=$(xcrun simctl create "shots-$name" "$type" "$runtime")
  xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" -b
  status_bar "$udid"
  xcrun simctl install "$udid" "$app"

  out="$out_root/$name"
  mkdir -p "$out"
  if [ -n "$duo" ]; then
    export DUOCTL_UDID="$udid"
    export DUO_INNER_OUT="$out_root/iphone-duo-inner"
    mkdir -p "$out/debug"
    # The simulator boots unfolded (SpringBoard on the inner display). Fold it:
    # Maestro only drives the cover display. Then one full unfold/refold cycle
    # before the flow, as a smoke test of the whole mechanism (the first call
    # also compiles duoctl's in-simulator helper): a simulator that cannot
    # switch screens fails here, in seconds, instead of mid-flow.
    duoctl state
    duo_fold || duo_reboot "$udid"
    duo_inner_shot "$out/debug/_duo-inner-boot.png" || echo "::warning::boot smoke: inner-display capture failed"
    duo_fold || duo_reboot "$udid"
    duoctl screenshot "$out/debug/_duo-cover-boot.png"
  else
    unset DUO_INNER_OUT || true
  fi

  # A cold simulator on a loaded runner sometimes never gets Maestro's XCTest
  # driver up ("iOS driver not ready in time", seen on the iPad after a ~9 min
  # boot). Retry once on a fresh boot, but only when no shot was taken, so a
  # real flow failure still fails fast.
  if ! run_flow "$out" "$udid" "$duo"; then
    if ls "$out"/*.png >/dev/null 2>&1; then return 1; fi
    echo "::warning::$name: flow produced no shots; rebooting simulator and retrying once"
    pkill -f xcodebuild || true
    xcrun simctl shutdown "$udid" || true
    xcrun simctl boot "$udid"
    xcrun simctl bootstatus "$udid" -b
    status_bar "$udid"
    [ -z "$duo" ] || duo_fold || duo_reboot "$udid"
    run_flow "$out" "$udid" "$duo"
  fi

  # shellcheck disable=SC2086
  check_sizes "$out" $sizes
  ls -l "$out"
  if [ -n "$duo" ]; then
    ls "$DUO_INNER_OUT"/*.png >/dev/null 2>&1 || { echo "::error::no inner-display screenshots were captured"; return 1; }
    check_sizes "$DUO_INNER_OUT" 2007x2853 2853x2007
    ls -l "$DUO_INNER_OUT"
    unset DUO_INNER_OUT DUOCTL_UDID
  fi

  xcrun simctl shutdown "$udid"
  xcrun simctl delete "$udid"
}

# `duoctl` is installed by the workflow (pinned commit, before any secret is
# pulled); without it the Duo cannot be folded. Checked first so a broken
# install fails in seconds, not after ~40 min of iPhone/iPad captures.
if xcrun simctl list devicetypes | grep -q 'iPhone Duo'; then
  command -v duoctl >/dev/null || { echo "::error::duoctl is not on PATH (see the 'Install duoctl' step in screenshots.yml)"; exit 1; }
  duoctl --help >/dev/null || { echo "::error::duoctl does not run (python3 missing?)"; exit 1; }
fi

# Each flow signs in as the same account, one device at a time.
capture iphone-6.3 '^iPhone [0-9]+ Pro$' '1206x2622 1179x2556'
capture ipad-13 '^iPad Pro 13-inch' '2064x2752'

capture iphone-duo-cover '^iPhone Duo$' '1398x2034 2034x1398' duo
