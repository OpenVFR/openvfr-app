/**
 * offlineCache — downloads and caches static aviation data + basemap tiles
 * so the app remains usable in flight without connectivity.
 *
 * Uses expo-file-system's new sync File/Directory API (SDK 54+) — `exists`,
 * `size`, and `uri` are plain synchronous getters, so callers can check cache
 * state without awaiting anything.
 *
 * Cache layout: <documentDirectory>/ovfr-offline/<name>
 *   basemap.pmtiles          — Protomaps vector basemap (large, ~600 MB+ for
 *                               a whole country; this is the dominant cost,
 *                               warn the user and require explicit opt-in)
 *   se-airspace.geojson
 *   se-aerodromes.geojson
 *   se-navaids.geojson
 *   se-waypoints.geojson
 *   se-runways.geojson
 *   se-runway-thresholds.geojson
 *   se-obstacles.geojson
 *   se-landmarks.geojson
 *   se-water.geojson (optional — Virtual Radar lake/reservoir crossings)
 */

import { File, Directory, Paths } from 'expo-file-system'
import { versionedTileUrl, getCachedTileManifest } from '@open-vfr/shared/tileManifest'
import { TILE_BASE } from '../config'

export interface OfflineAsset {
  key:       string
  label:     string
  fileName:  string
  /**
   * true  — flight-safety-critical aviation data. Always downloaded by
   *         downloadAll(); cannot be deselected in the offline-download UI.
   *         "Offline mode" cannot be considered ready unless every required
   *         asset is cached.
   * false — cosmetic/context layer (basemap, terrain, relief). User opts in
   *         per-asset via downloadSelected(); skipped by default to avoid
   *         surprising a mobile user with a multi-hundred-MB download.
   */
  required:  boolean
}

// BUG FIX: two separate real bugs previously here:
//   1. basemap/landuse/hillshade/contours hardcoded a `/tiles/` URL segment
//      (`${TILE_BASE}/tiles/basemap.pmtiles`) that 404s against real
//      production object storage (flat bucket root, no /tiles/ prefix)
//      -- the exact same bug class already fixed elsewhere in config.ts
//      (see that file's TILE_BASE comment) but missed here.
//   2. Every remoteUrl was a plain unversioned URL, computed once from a
//      module-level TILE_URLS const -- no cache-busting at all, unlike web's
//      equivalent fetches (all go through versionedTileUrl()). remoteUrl is
//      now computed on demand (remoteUrlFor()) so it always reflects the
//      manifest's current content hash at download time, not whatever was
//      cached (or not yet fetched) at app-startup/module-import time.
/** Content-hash-busted remote URL for a given tile filename -- see
 *  @open-vfr/shared/tileManifest's own doc comment for why this matters. */
export function remoteUrlFor(fileName: string): string {
  return versionedTileUrl(TILE_BASE, fileName)
}

export const OFFLINE_ASSETS: OfflineAsset[] = [
  { key: 'basemap',           label: 'Basemap (large)',       fileName: 'basemap.pmtiles',              required: false },
  // Shared Europe-wide low-zoom overview (z0-6) -- small (generalization
  // dominates over area at low zoom, unlike the country-detail basemap
  // above), same file regardless of which country's detail basemap is
  // active. Marked required: without it, offline users see bare gray past
  // the detail basemap's own country bbox/zoom range -- the same visible
  // gap this whole split was built to close, now also true offline.
  { key: 'basemapOverview',   label: 'Basemap overview',      fileName: 'europe-overview.pmtiles',      required: true },
  { key: 'landuse',           label: 'Terrain (landuse)',     fileName: 'se-landuse.pmtiles',           required: false },
  { key: 'hillshade',         label: 'Hillshade (relief, large)', fileName: 'se-hillshade.pmtiles',     required: false },
  { key: 'contours',          label: 'Contour lines',         fileName: 'se-contours.pmtiles',          required: false },
  { key: 'airspace',          label: 'Airspace',              fileName: 'se-airspace.geojson',          required: true },
  { key: 'aerodromes',        label: 'Aerodromes',            fileName: 'se-aerodromes.geojson',        required: true },
  { key: 'navaids',           label: 'Navaids',               fileName: 'se-navaids.geojson',           required: true },
  { key: 'waypoints',         label: 'Waypoints',             fileName: 'se-waypoints.geojson',         required: true },
  { key: 'runways',           label: 'Runways',               fileName: 'se-runways.geojson',           required: true },
  { key: 'runwayThresholds',  label: 'Runway thresholds',     fileName: 'se-runway-thresholds.geojson', required: true },
  { key: 'obstacles',         label: 'Obstacles',             fileName: 'se-obstacles.geojson',         required: true },
  { key: 'landmarks',         label: 'Landmarks',             fileName: 'se-landmarks.geojson',         required: true },
  { key: 'water',             label: 'Water (Virtual Radar)', fileName: 'se-water.geojson',             required: false },
]

export const REQUIRED_ASSETS: OfflineAsset[] = OFFLINE_ASSETS.filter(a => a.required)
export const OPTIONAL_ASSETS: OfflineAsset[] = OFFLINE_ASSETS.filter(a => !a.required)

/** True once every required (flight-safety-critical) asset is cached — the
 *  minimum bar for "Offline mode" to be considered usable. Optional/cosmetic
 *  assets (basemap, landuse, hillshade) are not part of this check. */
export function isOfflineReady(): boolean {
  return REQUIRED_ASSETS.every(isCached)
}

function getCacheDir(): Directory {
  const dir = new Directory(Paths.document, 'ovfr-offline')
  if (!dir.exists) dir.create({ intermediates: true })
  return dir
}

/** Local file:// URI an asset would live at, regardless of whether it's downloaded yet. */
export function localUriFor(asset: OfflineAsset): string {
  return new File(getCacheDir(), asset.fileName).uri
}

/** True if this asset has already been downloaded, is on disk, and is non-empty.
 *  A 0-byte/partial file (interrupted download, backgrounded app, network
 *  drop mid-transfer) must NOT count as cached -- MapLibre Native throws a
 *  "pmtiles magic number exception" trying to parse an empty/truncated
 *  pmtiles file, and a corrupt GeoJSON fails to parse. `.exists` alone can't
 *  tell a good file from a wrecked one. */
export function isCached(asset: OfflineAsset): boolean {
  const f = new File(getCacheDir(), asset.fileName)
  return f.exists && (f.size ?? 0) > 0
}

/** Returns the cached local URI if present and non-empty, else the (versioned)
 *  remote URL — safe default for any consumer. A stale 0-byte/partial local
 *  file must fall through to the remote URL, not be handed to the map
 *  renderer as-is (see isCached doc comment). */
export function resolveUri(asset: OfflineAsset): string {
  const f = new File(getCacheDir(), asset.fileName)
  return f.exists && (f.size ?? 0) > 0 ? f.uri : remoteUrlFor(asset.fileName)
}

/** Same lookup, keyed by TILE_URLS-style name, for call sites that don't want to import OFFLINE_ASSETS directly. */
export function resolveUriByKey(key: string): string {
  const asset = OFFLINE_ASSETS.find(a => a.key === key)
  if (!asset) throw new Error(`offlineCache: unknown asset key "${key}"`)
  return resolveUri(asset)
}

export interface CacheStatus {
  key:      string
  label:    string
  cached:   boolean
  sizeMb:   number | null
  /** true = a newer version of this file exists on the server than what's
   *  cached on disk (see isStale() doc comment). Only meaningful when cached. */
  stale:    boolean
}

export function getCacheStatus(): CacheStatus[] {
  return OFFLINE_ASSETS.map(a => {
    const f = new File(getCacheDir(), a.fileName)
    const cached = f.exists && (f.size ?? 0) > 0
    return {
      key:    a.key,
      label:  a.label,
      cached,
      sizeMb: cached && f.size != null ? Math.round((f.size / (1024 * 1024)) * 10) / 10 : null,
      stale:  cached && isStale(a),
    }
  })
}

export function getTotalCacheSizeMb(): number {
  const statuses = getCacheStatus()
  const bytes = statuses.reduce((sum, s) => sum + (s.sizeMb ?? 0), 0)
  return Math.round(bytes * 10) / 10
}

export interface DownloadProgress {
  assetKey:    string
  assetLabel:  string
  assetIndex:  number   // 1-based
  assetCount:  number
  bytesWritten: number
  totalBytes:   number
}

/**
 * Downloads a specific list of assets sequentially (not parallel — the
 * basemap/hillshade alone can be hundreds of MB, no reason to contend for
 * bandwidth with the small GeoJSON files at the same time). Existing files
 * are overwritten (idempotent) so this doubles as an "update offline data"
 * action for whichever assets are passed in.
 */
export async function downloadAssets(
  assets: OfflineAsset[],
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  const dir = getCacheDir()
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i]
    const dest  = new File(dir, asset.fileName)
    if (dest.exists) dest.delete()
    let announcedBytes = 0
    const task = File.createDownloadTask(remoteUrlFor(asset.fileName), dest, {
      onProgress: ({ bytesWritten, totalBytes }) => {
        if (totalBytes > 0) announcedBytes = totalBytes
        onProgress?.({
          assetKey: asset.key, assetLabel: asset.label,
          assetIndex: i + 1, assetCount: assets.length,
          bytesWritten, totalBytes,
        })
      },
    })
    try {
      await task.downloadAsync()
      // Interrupted/failed downloads (network drop, app backgrounded, disk
      // full) can still leave a 0-byte or truncated file on disk even though
      // downloadAsync() didn't throw. Never leave that behind as a fake
      // "cached" asset -- delete it so isCached()/resolveUri() correctly
      // fall back to the remote URL (or the next retry starts clean).
      if (!dest.exists || (dest.size ?? 0) === 0) {
        if (dest.exists) dest.delete()
        throw new Error(`offlineCache: download of "${asset.fileName}" produced an empty/missing file`)
      }
      // A truncated file (connection dropped after some bytes) is non-empty
      // and would pass isCached(), then fail inside MapLibre with a "pmtiles
      // magic number exception". When the manifest publishes the expected
      // size, require an exact match; otherwise fall back to the size the
      // server announced for this transfer.
      const expectedBytes = getCachedTileManifest()?.files?.[asset.fileName]?.bytes ?? announcedBytes
      if (expectedBytes && dest.size !== expectedBytes) {
        const got = dest.size
        dest.delete()
        throw new Error(`offlineCache: "${asset.fileName}" is incomplete (${got} of ${expectedBytes} bytes)`)
      }
      // Record the server-side content hash this download fetched, so a
      // later isStale() check has something to compare against once the
      // manifest moves on. Best-effort: if the manifest wasn't loaded yet
      // (offline first launch, race with index.js's bootstrap fetch), this
      // asset just isn't tracked for staleness until the next successful
      // download -- never blocks or fails the download itself.
      const serverHash = getCachedTileManifest()?.files?.[asset.fileName]?.sha256
      if (serverHash) {
        const sidecar = readSidecar()
        sidecar[asset.fileName] = serverHash
        writeSidecar(sidecar)
      }
    } catch (err) {
      if (dest.exists) dest.delete()
      throw err
    }
  }
}

/** Downloads every asset (required + optional) — original all-in behaviour, kept for back-compat call sites. */
export async function downloadAll(onProgress?: (p: DownloadProgress) => void): Promise<void> {
  await downloadAssets(OFFLINE_ASSETS, onProgress)
}

/** Downloads only the flight-safety-critical required assets — minimum viable "offline mode" download. */
export async function downloadRequired(onProgress?: (p: DownloadProgress) => void): Promise<void> {
  await downloadAssets(REQUIRED_ASSETS, onProgress)
}

/** Downloads a user-selected subset by key (e.g. required + whichever optional layers they checked). */
export async function downloadSelected(
  keys: string[],
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  const selected = OFFLINE_ASSETS.filter(a => keys.includes(a.key))
  await downloadAssets(selected, onProgress)
}

// ── Offline-copy staleness ───────────────────────────────────────────────
// downloadAssets() overwrites files in place with no record of WHICH
// server content (sha256) is now sitting on disk. Without that, a pilot
// who downloaded required (flight-safety-critical) data before a flight has
// no way to know a newer AIRAC cycle / obstacle update has since shipped to
// R2 while they were offline -- the Settings screen's cache list only shows
// "downloaded, N MB", never "outdated". Fixed by writing a small sidecar
// JSON of {fileName: sha256} next to the cached files at download time, and
// comparing it against the in-memory manifest (index.js's loadTileManifest()
// bootstrap fetch, or a Settings-triggered refreshTileManifest()) whenever
// asked.
const MANIFEST_SIDECAR_NAME = 'downloaded-manifest.json'

function readSidecar(): Record<string, string> {
  const f = new File(getCacheDir(), MANIFEST_SIDECAR_NAME)
  if (!f.exists) return {}
  try {
    return JSON.parse(f.textSync()) as Record<string, string>
  } catch {
    return {}
  }
}

function writeSidecar(hashes: Record<string, string>): void {
  const f = new File(getCacheDir(), MANIFEST_SIDECAR_NAME)
  if (f.exists) f.delete()
  f.write(JSON.stringify(hashes))
}

/**
 * True if this cached asset's on-disk content hash no longer matches the
 * server manifest's current sha256 for that filename -- i.e. a newer
 * version has been uploaded to R2 since this asset was last downloaded.
 * Returns false (not stale) whenever either side is unavailable (manifest
 * not loaded yet / offline, or this asset was downloaded before this
 * sidecar existed) -- never claims staleness without evidence.
 */
export function isStale(asset: OfflineAsset): boolean {
  if (!isCached(asset)) return false
  const manifest = getCachedTileManifest()
  const serverHash = manifest?.files?.[asset.fileName]?.sha256
  if (!serverHash) return false
  const sidecar = readSidecar()
  const localHash = sidecar[asset.fileName]
  if (!localHash) return false
  return localHash !== serverHash
}

/** Any required (flight-safety-critical) offline asset whose cached content
 *  is behind the current server manifest. Empty array = fully up to date
 *  (or manifest/sidecar unavailable to compare -- see isStale doc comment). */
export function getStaleRequiredAssets(): OfflineAsset[] {
  return REQUIRED_ASSETS.filter(a => isCached(a) && isStale(a))
}

export function clearCache(): void {
  const dir = getCacheDir()
  for (const entry of dir.list()) entry.delete()
}
