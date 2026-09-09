#!/usr/bin/env bash
# Build + install a production-config release APK (points at the configured
# EXPO_PUBLIC_API_BASE/EXPO_PUBLIC_TILE_BASE prod URLs, no Metro/dev-server
# required at runtime) onto the currently connected adb device.
#
# Gotchas this script guards against (see AGENTS.md for full writeup):
#   1. native/.env.local (dev override, EXPO_PUBLIC_API_BASE=http://localhost:5200)
#      takes dotenv precedence over native/.env — must be absent for the WHOLE
#      gradle invocation, not just a manual pre-bundle step.
#   2. Gradle's own `:app:createBundleReleaseJsAndAssets` task re-bundles the JS
#      itself as part of `assembleRelease` and caches (UP-TO-DATE) independent of
#      source changes — a stale/bad bundle can survive multiple rebuilds. We force
#      that one task to rerun explicitly before packaging.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_LOCAL=".env.local"
ENV_LOCAL_BAK=".env.local.prodbuild.bak"

restore_env_local() {
  if [ -f "$ENV_LOCAL_BAK" ]; then
    mv "$ENV_LOCAL_BAK" "$ENV_LOCAL"
    echo "[build-prod-apk] restored $ENV_LOCAL"
  fi
}
trap restore_env_local EXIT

if [ -f "$ENV_LOCAL" ]; then
  mv "$ENV_LOCAL" "$ENV_LOCAL_BAK"
  echo "[build-prod-apk] moved $ENV_LOCAL aside for prod build"
fi

echo "[build-prod-apk] forcing JS bundle rebuild (prod .env only)..."
(cd android && ./gradlew :app:createBundleReleaseJsAndAssets --rerun-tasks --no-daemon)

echo "[build-prod-apk] packaging release APK..."
(cd android && ./gradlew assembleRelease --no-daemon)

APK=android/app/build/outputs/apk/release/app-release.apk

echo "[build-prod-apk] verifying no localhost leaked into the shipped bundle..."
BUNDLE_CHECK=$(mktemp)
unzip -p "$APK" assets/index.android.bundle > "$BUNDLE_CHECK"
if grep -q "localhost:5200" "$BUNDLE_CHECK"; then
  rm -f "$BUNDLE_CHECK"
  echo "[build-prod-apk] FAIL: localhost:5200 found in shipped bundle — aborting install." >&2
  exit 1
fi
rm -f "$BUNDLE_CHECK"
echo "[build-prod-apk] OK — bundle is clean."

echo "[build-prod-apk] installing to connected device..."
adb install -r "$APK"

echo "[build-prod-apk] done. APK: $APK"
