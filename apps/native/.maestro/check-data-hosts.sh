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

# check <label> <url> [<expected-status-regex>] [curl args...]
# Without an expected status: fails on connection errors, cf-mitigated and 403/429/503.
# With one (e.g. '^(200|206)$'): the status must match it, so a 401/404 or an error page fails too.
check() {
  local label="$1" url="$2" expect="${3:-}" hdr code
  shift 3 2>/dev/null || shift $#
  hdr=$(mktemp)
  if ! code=$(curl -sS -o /dev/null -D "$hdr" -w '%{http_code}' \
      --retry 3 --retry-all-errors --max-time 20 "$@" "$url"); then
    echo "::error::$label unreachable from runner"
    fail=1
  elif grep -qi '^cf-mitigated:' "$hdr" || [[ "$code" =~ ^(403|429|503)$ ]]; then
    echo "::error::$label blocked or challenged from runner (HTTP $code)"
    fail=1
  elif [ -n "$expect" ] && ! [[ "$code" =~ $expect ]]; then
    echo "::error::$label answered HTTP $code (expected $expect)"
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
if require EXPO_PUBLIC_TILE_BASE; then
  # Optional tile host key (?ovk=): the app trims it and drops it unless it is 16-128 characters of A-Z a-z 0-9 _ -
  # (packages/shared/src/tileKey.ts parseTileKey), and then runs keyless and gets 403s. Fail here instead.
  tile_key="$(printf '%s' "${EXPO_PUBLIC_TILE_KEY:-}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [ -n "$tile_key" ] && ! [[ "$tile_key" =~ ^[A-Za-z0-9_-]{16,128}$ ]]; then
    echo "::error::EXPO_PUBLIC_TILE_KEY is set but malformed (16-128 characters of A-Z a-z 0-9 _ -): the app would ignore it and send no key"
    fail=1
    tile_key=""
  fi
  tile_q=""
  [ -n "$tile_key" ] && tile_q="?ovk=${tile_key}"
  # The app sends the key on every tile host request, the manifest included.
  check "EXPO_PUBLIC_TILE_BASE manifest" "${EXPO_PUBLIC_TILE_BASE%/}/manifest.json${tile_q}"
  # A tile host may serve files only with the build's key: read 16 bytes of a real file the way the app does.
  # Only 200/206 passes, so a missing or wrong key (403, or 401/404 from another host) fails here.
  check "EXPO_PUBLIC_TILE_BASE file read (with EXPO_PUBLIC_TILE_KEY if set)" \
    "${EXPO_PUBLIC_TILE_BASE%/}/europe-overview.pmtiles${tile_q}" '^(200|206)$' -r 0-15
fi
if [ -n "${EXPO_PUBLIC_BASEMAP_URL:-}" ]; then
  check "EXPO_PUBLIC_BASEMAP_URL" "$EXPO_PUBLIC_BASEMAP_URL"
fi

exit "$fail"
