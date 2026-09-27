#!/usr/bin/env bash
# Pre-flight for the screenshot workflow: verifies this runner can actually
# reach the hosts the app build will talk to, before spending ~30 min on
# native builds that would only produce blank-map screenshots.
#
# Usage: check-data-hosts.sh <env-file>
#   <env-file>  output of `eas env:pull` for the build profile's environment
#
# Fails on: unset base URLs (the app would fall back to localhost),
# connection errors, and edge bot-protection responses (challenge header or
# 403/429/503) -- datacenter runner IPs are a common target for those.
# URLs themselves are never printed, only their variable names.
set -euo pipefail

env_file="$1"
set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

fail=0

check() {
  local label="$1" url="$2" hdr code
  hdr=$(mktemp)
  if ! code=$(curl -sS -o /dev/null -D "$hdr" -w '%{http_code}' \
      --retry 3 --retry-all-errors --max-time 20 "$url"); then
    echo "::error::$label unreachable from runner"
    fail=1
  elif grep -qi '^cf-mitigated:' "$hdr" || [[ "$code" =~ ^(403|429|503)$ ]]; then
    echo "::error::$label blocked or challenged from runner (HTTP $code)"
    fail=1
  else
    echo "ok: $label (HTTP $code)"
  fi
  rm -f "$hdr"
}

require() {
  if [ -z "${!1:-}" ]; then
    echo "::error::$1 not set in the EAS environment -- the build would point at localhost"
    fail=1
    return 1
  fi
}

require EXPO_PUBLIC_API_BASE  && check "EXPO_PUBLIC_API_BASE /health" "${EXPO_PUBLIC_API_BASE%/}/health"
require EXPO_PUBLIC_TILE_BASE && check "EXPO_PUBLIC_TILE_BASE"        "${EXPO_PUBLIC_TILE_BASE%/}/"
if [ -n "${EXPO_PUBLIC_BASEMAP_URL:-}" ]; then
  check "EXPO_PUBLIC_BASEMAP_URL" "$EXPO_PUBLIC_BASEMAP_URL"
fi

exit "$fail"
