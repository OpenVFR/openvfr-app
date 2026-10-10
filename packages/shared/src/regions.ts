/**
 * Supported European regions (ISO 3166-1 alpha-2, lower-case) with rough
 * bounding boxes. Shared: web's RegionSelector uses it for the region
 * picker; notamRelevance.ts uses the boxes to work out which countries
 * (and therefore FIRs) a position or route touches.
 */

export interface Region {
  /** ISO 3166-1 alpha-2, lower-case */
  code: string
  name: string
  /** Overpass bounding box: [south, west, north, east] */
  bbox: readonly [number, number, number, number]
}

/**
 * Region a client starts in before the user picks one (web's region
 * selector; native has no picker yet). The only region with a full data
 * pipeline today.
 */
export const DEFAULT_REGION_CODE = 'se'

/**
 * Selected regions are a list: a user may work across several countries
 * once their tiles exist. Region-scoped data (e.g. regional NOTAMs, see
 * ./notamRegionScope) must take the whole list, never assume one.
 */
export const DEFAULT_REGION_CODES: readonly string[] = [DEFAULT_REGION_CODE]

/** All supported European regions, grouped loosely north → south. */
export const EUROPEAN_REGIONS: Region[] = [
  // ── Nordic ────────────────────────────────────────────────────────────────
  { code: 'se', name: 'Sweden',          bbox: [ 55.3,  10.9, 69.1, 24.2] },
  { code: 'no', name: 'Norway',          bbox: [ 57.0,   4.5, 71.2, 31.3] },
  { code: 'fi', name: 'Finland',         bbox: [ 59.8,  19.6, 70.1, 31.6] },
  { code: 'dk', name: 'Denmark',         bbox: [ 54.6,   8.1, 57.8, 15.2] },
  { code: 'is', name: 'Iceland',         bbox: [ 63.3, -25.0, 66.6,-13.5] },
  // ── Baltic ────────────────────────────────────────────────────────────────
  { code: 'ee', name: 'Estonia',         bbox: [ 57.5,  21.7, 59.7, 28.2] },
  { code: 'lv', name: 'Latvia',          bbox: [ 55.7,  20.9, 57.9, 28.2] },
  { code: 'lt', name: 'Lithuania',       bbox: [ 53.9,  20.9, 56.5, 26.8] },
  // ── British Isles ─────────────────────────────────────────────────────────
  { code: 'gb', name: 'United Kingdom',  bbox: [ 49.9,  -8.2, 60.9,  1.8] },
  { code: 'ie', name: 'Ireland',         bbox: [ 51.4, -10.5, 55.4, -5.9] },
  // ── Western Europe ────────────────────────────────────────────────────────
  { code: 'fr', name: 'France',          bbox: [ 41.3,  -5.1, 51.1,  9.6] },
  { code: 'be', name: 'Belgium',         bbox: [ 49.5,   2.5, 51.5,  6.4] },
  { code: 'nl', name: 'Netherlands',     bbox: [ 50.7,   3.4, 53.6,  7.2] },
  { code: 'lu', name: 'Luxembourg',      bbox: [ 49.4,   5.7, 50.2,  6.5] },
  // ── Central Europe ────────────────────────────────────────────────────────
  { code: 'de', name: 'Germany',         bbox: [ 47.3,   5.9, 55.1, 15.0] },
  { code: 'at', name: 'Austria',         bbox: [ 46.4,   9.5, 49.0, 17.2] },
  { code: 'ch', name: 'Switzerland',     bbox: [ 45.8,   6.0, 47.8, 10.5] },
  { code: 'pl', name: 'Poland',          bbox: [ 49.0,  14.1, 54.9, 24.2] },
  { code: 'cz', name: 'Czechia',         bbox: [ 48.5,  12.1, 51.1, 18.9] },
  { code: 'sk', name: 'Slovakia',        bbox: [ 47.7,  16.8, 49.6, 22.6] },
  { code: 'hu', name: 'Hungary',         bbox: [ 45.7,  16.1, 48.6, 22.9] },
  // ── Southern Europe ───────────────────────────────────────────────────────
  { code: 'es', name: 'Spain',           bbox: [ 36.0,  -9.3, 43.8,  3.4] },
  { code: 'pt', name: 'Portugal',        bbox: [ 36.8,  -9.5, 42.2, -6.2] },
  { code: 'it', name: 'Italy',           bbox: [ 35.5,   6.7, 47.1, 18.5] },
  { code: 'gr', name: 'Greece',          bbox: [ 34.8,  20.1, 41.8, 26.6] },
  { code: 'cy', name: 'Cyprus',          bbox: [ 34.6,  32.3, 35.7, 34.6] },
  { code: 'mt', name: 'Malta',           bbox: [ 35.8,  14.2, 36.1, 14.6] },
  // ── South-East Europe ─────────────────────────────────────────────────────
  { code: 'ro', name: 'Romania',         bbox: [ 43.6,  20.3, 48.3, 29.7] },
  { code: 'bg', name: 'Bulgaria',        bbox: [ 41.2,  22.4, 44.2, 28.6] },
  { code: 'hr', name: 'Croatia',         bbox: [ 42.4,  13.5, 46.6, 19.4] },
  { code: 'si', name: 'Slovenia',        bbox: [ 45.4,  13.4, 46.9, 16.6] },
  { code: 'rs', name: 'Serbia',          bbox: [ 42.2,  18.8, 46.2, 23.0] },
  { code: 'ba', name: 'Bosnia & Herz.',  bbox: [ 42.6,  15.7, 45.3, 19.6] },
  { code: 'me', name: 'Montenegro',      bbox: [ 41.8,  18.4, 43.6, 20.4] },
  { code: 'mk', name: 'N. Macedonia',    bbox: [ 40.8,  20.4, 42.4, 23.0] },
  { code: 'al', name: 'Albania',         bbox: [ 39.6,  19.3, 42.7, 21.1] },
  // ── Eastern Europe ────────────────────────────────────────────────────────
  { code: 'ua', name: 'Ukraine',         bbox: [ 44.4,  22.1, 52.4, 40.2] },
  { code: 'md', name: 'Moldova',         bbox: [ 45.5,  26.6, 48.5, 30.2] },
  { code: 'by', name: 'Belarus',         bbox: [ 51.3,  23.2, 56.2, 32.8] },
]
