# shellcheck shell=bash
# iPhone Duo fold helpers around duoctl (sourced by capture-ios.sh and
# run-flow.sh; DUOCTL_UDID names the simulator).
#
# The inner display sits a quarter turn from the cover: unfolded with the
# device upright it shows landscape, and `duoctl rotate portrait` gets the
# inner portrait by turning the DEVICE to landscape-left. Folding with the
# device still turned leaves the app rotated on the (portrait) cover, so
# Maestro's taps miss, and the cover sometimes never takes over. So unfold ->
# rotate -> shot, then turn the device back upright (inner "landscape" is
# device portrait, the first orientation duoctl tries) before folding.

# duo_inner_shot <png>: unfold, rotate the inner display to portrait, capture.
duo_inner_shot() {
  duoctl open || return 1
  duoctl rotate portrait || echo "::warning::inner display stayed landscape for $(basename "$1")"
  sleep 1
  duoctl screenshot "$1"
}

# duo_fold: device upright again, then fold onto the cover (retried once).
duo_fold() {
  if duoctl state 2>/dev/null | grep -q '"activeScreen": "inner"'; then
    duoctl rotate landscape >/dev/null || echo "::warning::could not turn the Duo back upright before folding"
  fi
  duoctl close && return 0
  echo "::warning::the cover did not take over after folding; retrying"
  duoctl state || true
  sleep 2
  duoctl close
}
