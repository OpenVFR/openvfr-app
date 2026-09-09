#!/usr/bin/env node
// scripts/remove-tiles-from-dist.mjs
//
// Removes dist/tiles/ after `vite build` finishes.
//
// Vite's default copyPublicDir behavior copies public/* into dist/*
// verbatim, including public/tiles/*.pmtiles and *.geojson. Those files
// are meant to be served from separate static/object storage (see
// docs/self-hosting.md), not bundled into the app's own static deploy:
//   - Many static-hosting providers hard-fail on any file over ~25 MiB —
//     a full basemap PMTiles archive can be several hundred MB.
//   - Architecturally these are large, AIRAC-cadence data files that
//     belong on their own storage/CDN, not redeployed alongside every
//     frontend build.
//
// Safe to run AFTER `vite build` (not before, and not via
// build.copyPublicDir:false): vite-plugin-pwa's precache-manifest
// generation already excludes *.pmtiles/*.mbtiles via globIgnores
// (vite.config.ts), so removing these files post-build doesn't change
// what the service worker precaches — it only affects what gets deployed,
// leaving small icon assets (aircraft_icons/, poi_icons/) untouched and
// precached exactly as before.
//
// public/tiles/*.pmtiles, *.mbtiles, *.geojson are gitignored — a fresh
// CI checkout never has them populated in the first place, so this mainly
// matters when building from a local checkout that has tiles downloaded
// for dev/testing — this script makes the exclusion explicit and
// CI-environment-independent rather than relying on gitignore-by-luck.
//
// Run via: node scripts/remove-tiles-from-dist.mjs (wired into `pnpm build`,
// runs AFTER `vite build`)

import { rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const DIST_TILES_DIR = join(process.cwd(), 'dist', 'tiles')

try {
  const before = await readdir(DIST_TILES_DIR)
  await rm(DIST_TILES_DIR, { recursive: true, force: true })
  console.log(`[remove-tiles-from-dist] Removed dist/tiles/ (${before.length} entries) — served from separate storage, not bundled (see docs/self-hosting.md).`)
} catch (err) {
  if (err.code === 'ENOENT') {
    console.log('[remove-tiles-from-dist] dist/tiles/ not present (expected on a fresh CI checkout — public/tiles/*.pmtiles etc. are gitignored) — nothing to remove.')
  } else {
    throw err
  }
}
