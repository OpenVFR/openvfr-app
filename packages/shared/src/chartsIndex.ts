/**
 * Charts index: optional per-country file `<cc>-charts.json` listing each
 * aerodrome's official published charts (visual approach charts, aerodrome
 * charts, ...) as links to the publisher's own documents, optionally with a
 * georeference so a chart can be drawn on the map.
 *
 * EXPERIMENTAL. The file is not part of the standard dataset set; a
 * deployment without it simply has no Charts section. How a deployment
 * produces it is up to the operator (see docs/architecture.md, "Charts
 * index"); the app only reads it.
 *
 * Display rules carried by the file itself (`display`):
 *   document  the app may open/view the official document
 *   overlay   the app may draw charts that carry `georef` on the map
 * Documents are always fetched from the publisher (directly, or through the
 * API's pass-through endpoint where the browser can't fetch cross-origin),
 * never altered or republished.
 */

export type ChartKind = 'VAC' | 'ADC' | 'PDC' | 'GMC' | 'IAC' | 'SID' | 'STAR' | 'AREA' | 'OBST' | 'OTHER'

export type LngLat = [number, number]

export interface ChartGeoref {
  method: string
  /** 1-based PDF page the georeference applies to. */
  page: number
  page_size_pt: [number, number]
  /** Whole page corners: top-left, top-right, bottom-right, bottom-left. */
  corners: [LngLat, LngLat, LngLat, LngLat]
  /** Map frame as fractions of the page: [left, top, right, bottom]. */
  crop?: [number, number, number, number]
  /** Map frame corners (TL, TR, BR, BL) -- what an overlay should draw. */
  crop_corners?: [LngLat, LngLat, LngLat, LngLat]
  /** Estimated positional accuracy of the fit, metres. */
  accuracy_m?: number
  printed_scale?: number | null
}

export interface ChartEntry {
  id: string
  title: string
  kind: ChartKind
  /** The publisher's own document URL. */
  url: string
  georef?: ChartGeoref
}

export interface ChartsAerodrome {
  name?: string
  /** The publisher's page for this aerodrome (e.g. its AIP AD 2 section). */
  info_url?: string | null
  charts: ChartEntry[]
}

export interface ChartsIndex {
  schema: string
  country: string
  /** Effective date of the publication cycle the links point at (YYYY-MM-DD). */
  cycle: string | null
  source: { name: string; url: string; attribution: string }
  display: { document: boolean; overlay: boolean }
  aerodromes: Record<string, ChartsAerodrome>
}

export const CHARTS_SCHEMA = 'openvfr.charts/1'

const KINDS: readonly ChartKind[] = ['VAC', 'ADC', 'PDC', 'GMC', 'IAC', 'SID', 'STAR', 'AREA', 'OBST', 'OTHER']

/** Display order of chart kinds: VFR-relevant first. */
export const CHART_KIND_ORDER: readonly ChartKind[] = ['VAC', 'ADC', 'PDC', 'GMC', 'AREA', 'OBST', 'IAC', 'SID', 'STAR', 'OTHER']

export const CHART_KIND_LABEL: Record<ChartKind, string> = {
  VAC: 'Visual approach',
  ADC: 'Aerodrome',
  PDC: 'Parking / docking',
  GMC: 'Ground movement',
  IAC: 'Instrument approach',
  SID: 'Departure (SID)',
  STAR: 'Arrival (STAR)',
  AREA: 'Area',
  OBST: 'Obstacle / terrain',
  OTHER: 'Other',
}

/** Kinds shown without expanding (the rest sit behind "More charts"). */
export const VFR_CHART_KINDS: ReadonlySet<ChartKind> = new Set(['VAC', 'ADC', 'PDC', 'GMC'])

function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false
  try { return new URL(v).protocol === 'https:' } catch { return false }
}

function isLngLat(v: unknown): v is LngLat {
  return Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n))
    && Math.abs(v[0]) <= 180 && Math.abs(v[1]) <= 90
}

function isQuad(v: unknown): v is [LngLat, LngLat, LngLat, LngLat] {
  return Array.isArray(v) && v.length === 4 && v.every(isLngLat)
}

function parseGeoref(v: unknown): ChartGeoref | undefined {
  if (!v || typeof v !== 'object') return undefined
  const g = v as Record<string, unknown>
  if (!isQuad(g['corners'])) return undefined
  const size = g['page_size_pt']
  if (!Array.isArray(size) || size.length !== 2 || !size.every(n => typeof n === 'number' && n > 0)) return undefined
  const crop = g['crop']
  const cropOk = Array.isArray(crop) && crop.length === 4 && crop.every(n => typeof n === 'number' && n >= 0 && n <= 1)
    && (crop[2] as number) > (crop[0] as number) && (crop[3] as number) > (crop[1] as number)
  return {
    method: String(g['method'] ?? ''),
    page: typeof g['page'] === 'number' && g['page'] >= 1 ? g['page'] : 1,
    page_size_pt: size as [number, number],
    corners: g['corners'],
    crop: cropOk ? crop as [number, number, number, number] : undefined,
    crop_corners: cropOk && isQuad(g['crop_corners']) ? g['crop_corners'] : undefined,
    accuracy_m: typeof g['accuracy_m'] === 'number' ? g['accuracy_m'] : undefined,
    printed_scale: typeof g['printed_scale'] === 'number' ? g['printed_scale'] : null,
  }
}

/**
 * Validate an untrusted charts file. Drops malformed entries instead of
 * failing the whole file; returns null when the file isn't a charts index
 * at all. Only https document URLs are kept.
 */
export function parseChartsIndex(raw: unknown): ChartsIndex | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r['schema'] !== CHARTS_SCHEMA) return null
  const src = (r['source'] ?? {}) as Record<string, unknown>
  const disp = (r['display'] ?? {}) as Record<string, unknown>
  const index: ChartsIndex = {
    schema: CHARTS_SCHEMA,
    country: String(r['country'] ?? '').toLowerCase(),
    cycle: typeof r['cycle'] === 'string' ? r['cycle'] : null,
    source: {
      name: String(src['name'] ?? ''),
      url: isHttpsUrl(src['url']) ? src['url'] : '',
      attribution: String(src['attribution'] ?? src['name'] ?? ''),
    },
    display: { document: disp['document'] === true, overlay: disp['overlay'] === true },
    aerodromes: {},
  }
  const ads = (r['aerodromes'] ?? {}) as Record<string, unknown>
  for (const [icao, adRaw] of Object.entries(ads)) {
    if (!/^[A-Z0-9]{3,4}$/.test(icao) || !adRaw || typeof adRaw !== 'object') continue
    const ad = adRaw as Record<string, unknown>
    const charts: ChartEntry[] = []
    for (const cRaw of Array.isArray(ad['charts']) ? ad['charts'] : []) {
      if (!cRaw || typeof cRaw !== 'object') continue
      const c = cRaw as Record<string, unknown>
      if (!isHttpsUrl(c['url']) || typeof c['title'] !== 'string') continue
      const kind = KINDS.includes(c['kind'] as ChartKind) ? c['kind'] as ChartKind : 'OTHER'
      const georef = index.display.overlay ? parseGeoref(c['georef']) : undefined
      charts.push({ id: String(c['id'] ?? c['url']), title: c['title'], kind, url: c['url'], ...(georef ? { georef } : {}) })
    }
    index.aerodromes[icao] = {
      name: typeof ad['name'] === 'string' ? ad['name'] : undefined,
      info_url: isHttpsUrl(ad['info_url']) ? ad['info_url'] : null,
      charts,
    }
  }
  return index
}

export interface AerodromeCharts {
  icao: string
  charts: ChartEntry[]
  infoUrl: string | null
  source: ChartsIndex['source']
  cycle: string | null
  display: ChartsIndex['display']
}

/** Charts for one aerodrome from any of the loaded indexes, sorted by kind. */
export function chartsForAerodrome(indexes: readonly ChartsIndex[], icao: string): AerodromeCharts | null {
  for (const idx of indexes) {
    const ad = idx.aerodromes[icao]
    if (!ad) continue
    const order = (k: ChartKind) => CHART_KIND_ORDER.indexOf(k)
    const charts = [...ad.charts].sort((a, b) => order(a.kind) - order(b.kind))
    return { icao, charts, infoUrl: ad.info_url ?? null, source: idx.source, cycle: idx.cycle, display: idx.display }
  }
  return null
}

/** Corners and page crop an overlay should use: the map frame when known,
 *  else the whole page. */
export function overlayGeometry(g: ChartGeoref): { corners: [LngLat, LngLat, LngLat, LngLat]; crop: [number, number, number, number] } {
  if (g.crop && g.crop_corners) return { corners: g.crop_corners, crop: g.crop }
  return { corners: g.corners, crop: [0, 0, 1, 1] }
}

/** URL of the API's pass-through endpoint for an official document. */
export function chartDocumentProxyUrl(apiBaseUrl: string, documentUrl: string): string {
  return `${apiBaseUrl}/api/charts/document?url=${encodeURIComponent(documentUrl)}`
}

/**
 * Hosts an index lists documents on -- what a deployment puts in the API's
 * CHART_DOCUMENT_HOSTS allow-list.
 */
export function chartDocumentHosts(index: ChartsIndex): string[] {
  const hosts = new Set<string>()
  for (const ad of Object.values(index.aerodromes)) {
    for (const c of ad.charts) hosts.add(new URL(c.url).hostname)
  }
  return [...hosts].sort()
}
