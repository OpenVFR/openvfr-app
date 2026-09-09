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
import { TILE_BASE, TILE_URLS } from '../config'

export interface OfflineAsset {
  key:       string
  label:     string
  remoteUrl: string
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

export const OFFLINE_ASSETS: OfflineAsset[] = [
  { key: 'basemap',           label: 'Basemap (large)',      remoteUrl: `${TILE_BASE}/tiles/basemap.pmtiles`,        fileName: 'basemap.pmtiles',           required: false },
  { key: 'landuse',           label: 'Terrain (landuse)',    remoteUrl: `${TILE_BASE}/tiles/se-landuse.pmtiles`,     fileName: 'se-landuse.pmtiles',        required: false },
  { key: 'hillshade',         label: 'Hillshade (relief, large)', remoteUrl: `${TILE_BASE}/tiles/se-hillshade.pmtiles`, fileName: 'se-hillshade.pmtiles',   required: false },
  { key: 'contours',          label: 'Contour lines',        remoteUrl: `${TILE_BASE}/tiles/se-contours.pmtiles`,     fileName: 'se-contours.pmtiles',       required: false },
  { key: 'airspace',          label: 'Airspace',              remoteUrl: TILE_URLS.airspace,         fileName: 'se-airspace.geojson',       required: true },
  { key: 'aerodromes',        label: 'Aerodromes',            remoteUrl: TILE_URLS.aerodromes,       fileName: 'se-aerodromes.geojson',     required: true },
  { key: 'navaids',           label: 'Navaids',               remoteUrl: TILE_URLS.navaids,          fileName: 'se-navaids.geojson',        required: true },
  { key: 'waypoints',         label: 'Waypoints',             remoteUrl: TILE_URLS.waypoints,        fileName: 'se-waypoints.geojson',      required: true },
  { key: 'runways',           label: 'Runways',               remoteUrl: TILE_URLS.runways,          fileName: 'se-runways.geojson',        required: true },
  { key: 'runwayThresholds',  label: 'Runway thresholds',     remoteUrl: TILE_URLS.runwayThresholds, fileName: 'se-runway-thresholds.geojson', required: true },
  { key: 'obstacles',         label: 'Obstacles',             remoteUrl: TILE_URLS.obstacles,        fileName: 'se-obstacles.geojson',      required: true },
  { key: 'landmarks',         label: 'Landmarks',             remoteUrl: TILE_URLS.landmarks,        fileName: 'se-landmarks.geojson',      required: true },
  { key: 'water',             label: 'Water (Virtual Radar)', remoteUrl: TILE_URLS.water,            fileName: 'se-water.geojson',          required: false },
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

/** True if this asset has already been downloaded and is on disk. */
export function isCached(asset: OfflineAsset): boolean {
  return new File(getCacheDir(), asset.fileName).exists
}

/** Returns the cached local URI if present, else the remote URL — safe default for any consumer. */
export function resolveUri(asset: OfflineAsset): string {
  const f = new File(getCacheDir(), asset.fileName)
  return f.exists ? f.uri : asset.remoteUrl
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
}

export function getCacheStatus(): CacheStatus[] {
  return OFFLINE_ASSETS.map(a => {
    const f = new File(getCacheDir(), a.fileName)
    return {
      key:    a.key,
      label:  a.label,
      cached: f.exists,
      sizeMb: f.exists && f.size != null ? Math.round((f.size / (1024 * 1024)) * 10) / 10 : null,
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
    const task = File.createDownloadTask(asset.remoteUrl, dest, {
      onProgress: ({ bytesWritten, totalBytes }) => {
        onProgress?.({
          assetKey: asset.key, assetLabel: asset.label,
          assetIndex: i + 1, assetCount: assets.length,
          bytesWritten, totalBytes,
        })
      },
    })
    await task.downloadAsync()
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

export function clearCache(): void {
  const dir = getCacheDir()
  for (const entry of dir.list()) entry.delete()
}
