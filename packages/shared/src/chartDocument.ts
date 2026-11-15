/**
 * Rules for opening an official chart document on a device that fetches the publisher's PDF itself (the native apps; the web app goes
 * through the API's pass-through because browsers cannot). Pure, so they are unit-tested here and used by apps/native.
 *
 * The document URL comes from the published charts index (served by our own tile host: that is the trust anchor), never from the
 * user, and is still checked: https only, no credentials or port, a .pdf path, and a host the index itself lists. NOTE the last one is
 * a sanity check, not an allow-list: the host set is derived from the same index, so it is always satisfied by an entry of that
 * index. The API's pass-through has a real allow-list (CHART_DOCUMENT_HOSTS); a device has none. The file is kept in a small cache,
 * one per edition.
 */
import { CHART_ID, chartDocumentHosts, type ChartsIndex, type ChartEntry, type LngLat } from './chartsIndex'

/** Largest document a device downloads (the API pass-through caps at 20 MB too). */
export const CHART_DOCUMENT_MAX_BYTES = 25 * 1024 * 1024
/** Documents kept on the device (least recently used go first). */
export const CHART_DOCUMENT_KEEP = 8
/** Most pixels a rendered page may have (width x height): about 64 MB of RGBA. */
export const MAX_RENDER_PIXELS = 16_000_000

export type DocumentUrlCheck = { url: string } | { error: string }

/** The document URL if this device may fetch it, else a reason. `hosts` = the hostnames the charts index lists documents on (see the note above: not an allow-list). */
export function checkChartDocumentUrl(raw: string | undefined, hosts: ReadonlySet<string>): DocumentUrlCheck {
  if (!raw || raw.length > 2048) return { error: 'missing or too long' }
  let u: URL
  try { u = new URL(raw) } catch { return { error: 'not a URL' } }
  if (u.protocol !== 'https:') return { error: 'https only' }
  if (u.username || u.password) return { error: 'credentials not allowed' }
  if (u.port && u.port !== '443') return { error: 'port not allowed' }
  if (!hosts.has(u.hostname.toLowerCase())) return { error: 'host not listed in the index' }
  let path: string
  try { path = decodeURIComponent(u.pathname) } catch { return { error: 'bad path encoding' } }
  if (!/\.pdf$/i.test(path)) return { error: 'not a PDF path' }
  u.hash = ''
  return { url: u.toString() }
}

/** Hostnames an index lists documents on, lower-cased, as a set (what checkChartDocumentUrl wants). */
export const documentHostSet = (index: ChartsIndex): Set<string> => new Set(chartDocumentHosts(index).map(h => h.toLowerCase()))

/** The cache file name of one chart edition; null for an id that is not a safe file name part. */
export function chartDocumentFileName(country: string, chart: Pick<ChartEntry, 'id'>): string | null {
  if (!/^[a-z]{2}$/.test(country) || !CHART_ID.test(chart.id)) return null
  return `${country}-${chart.id}.pdf`
}

/** Which cached files to delete so that at most `keep` remain: the oldest by modification time. */
export function documentsToEvict(files: ReadonlyArray<{ name: string; modified: number }>, keep: number = CHART_DOCUMENT_KEEP): string[] {
  return [...files].sort((a, b) => b.modified - a.modified).slice(Math.max(0, keep)).map(f => f.name)
}

/** The PDF header: a real document starts with %PDF-. */
export const looksLikePdf = (head: Uint8Array): boolean =>
  head.byteLength >= 5 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d

/** South-west and north-east of a quad of corners (lng/lat), for fitting the camera to a chart. */
export function cornersBounds(corners: readonly LngLat[]): { sw: LngLat; ne: LngLat } {
  const lngs = corners.map(c => c[0])
  const lats = corners.map(c => c[1])
  return { sw: [Math.min(...lngs), Math.min(...lats)], ne: [Math.max(...lngs), Math.max(...lats)] }
}

/** Whether a quad of corners overlaps the visible bounds (so a chart already in view is not re-framed). */
export function cornersVisible(corners: readonly LngLat[], view: { sw: LngLat; ne: LngLat }): boolean {
  const b = cornersBounds(corners)
  return view.sw[0] < b.ne[0] && view.ne[0] > b.sw[0] && view.sw[1] < b.ne[1] && view.ne[1] > b.sw[1]
}

/**
 * Pixel size to render a page (or a crop of it, as page fractions) at: `targetWidthPx` wide, shrunk so width x height never passes
 * MAX_RENDER_PIXELS. Page size in PDF points. Always at least 1 x 1.
 */
export function renderSize(
  pageWidthPt: number, pageHeightPt: number, targetWidthPx: number,
  crop: readonly [number, number, number, number] = [0, 0, 1, 1], maxPixels: number = MAX_RENDER_PIXELS,
): { width: number; height: number; scale: number } {
  const cropW = pageWidthPt * (crop[2] - crop[0])
  const cropH = pageHeightPt * (crop[3] - crop[1])
  let scale = targetWidthPx / cropW
  scale = Math.min(scale, Math.sqrt(maxPixels / (cropW * cropH)))
  // floor, never round: rounding up could put width x height a few pixels over the cap
  return { width: Math.max(1, Math.floor(cropW * scale + 1e-6)), height: Math.max(1, Math.floor(cropH * scale + 1e-6)), scale }
}

/** What the chart bar says about the position accuracy of an overlay (rounded up to 50 m, at least 100 m). */
export const overlayAccuracyLabel = (accuracyM: number | undefined): string =>
  `±${accuracyM ? Math.max(100, Math.round(accuracyM / 50) * 50) : '?'} m`
