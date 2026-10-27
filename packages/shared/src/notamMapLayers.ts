/**
 * notamMapLayers -- what regional NOTAMs look like on the map, shared by web
 * (MapView.tsx, imperative maplibre-gl) and native (MapScreen.tsx,
 * declarative RN MapLibre). The two maps only differ in HOW they feed
 * GeoJSON to the renderer; which NOTAM becomes a circle, polygon or point,
 * and which circles are hidden because a charted area replaces them, is
 * decided here once.
 *
 *   - polygon  : NOTAM has a real polygon (from its text) -> fill
 *   - circle   : lat/lon + radius > 0 and no polygon -> synthesized circle,
 *                unless every designator it names is a charted area
 *   - point    : lat/lon without radius
 *   - matched  : charted R/D/TRA polygons a NOTAM names by designator
 *                ("ESD873", "EFR143A") -> highlight + NOTAM in their popup
 *
 * Matching by designator only works where we have charted airspace (today
 * only the active countries' airspace GeoJSON); a NOTAM naming an area we
 * don't have keeps its Q-line circle.
 */
import type { Feature, FeatureCollection, MultiPolygon, Point, Polygon } from 'geojson'
import type { NotamItem } from './fetchNotam'
import { extractDesignators } from './notamDesignator'
import { makeCirclePolygon } from './geoCircle'
import { isOffSchedule } from './notamSchedule'

type AreaGeometry = Polygon | MultiPolygon

export interface AirspaceIndexEntry {
  /** Full charted name, e.g. "ESD873 OPTAND". */
  name: string
  /** Leading designator, e.g. "ESD873" or "ESR15A". */
  designator: string
  geometry: AreaGeometry
}

export interface MatchedAirspaceNotam {
  airspaceName: string
  geometry: AreaGeometry
  notams: NotamItem[]
}

export interface NotamAirspaceMatch {
  matches: MatchedAirspaceNotam[]
  /**
   * NOTAMs (by nmsId, not the display id -- different authorities reuse the
   * same published number) whose designators are ALL charted: their ad-hoc
   * circle is redundant and hidden. A NOTAM naming one charted and one
   * uncharted area is in `matches` but not here, so its circle stays.
   */
  matchedNotamIds: Set<string>
}

const NAME_DESIGNATOR = /^([A-Z]{2}[RD]\d{1,4}[A-Z]?)(?![A-Z0-9])/

/** Charted restricted / danger / TRA polygons, keyed by their name's designator. */
export function buildAirspaceIndex(fc: FeatureCollection): AirspaceIndexEntry[] {
  const out: AirspaceIndexEntry[] = []
  for (const f of fc.features) {
    const g = f.geometry
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue
    const p = (f.properties ?? {}) as Record<string, unknown>
    const cls = String(p['class'] ?? '')
    if (cls !== 'R' && cls !== 'D' && cls !== 'TRA') continue
    const name = String(p['name'] ?? '')
    const m = NAME_DESIGNATOR.exec(name)
    if (!m) continue
    out.push({ name, designator: m[1]!, geometry: g })
  }
  return out
}

/** Sector-less base of a designator: "ESR22A" -> "ESR22". */
const baseOf = (d: string): string => d.replace(/[A-Z]$/, '')

export function matchNotamsToAirspace(index: readonly AirspaceIndexEntry[], notams: readonly NotamItem[]): NotamAirspaceMatch {
  const exact = new Map<string, AirspaceIndexEntry[]>()
  const byBase = new Map<string, AirspaceIndexEntry[]>()
  const push = (m: Map<string, AirspaceIndexEntry[]>, k: string, e: AirspaceIndexEntry) => {
    const l = m.get(k)
    if (l) l.push(e); else m.set(k, [e])
  }
  for (const e of index) {
    push(exact, e.designator, e)
    push(byBase, baseOf(e.designator), e)
  }

  const grouped = new Map<string, MatchedAirspaceNotam>()
  const matchedNotamIds = new Set<string>()

  for (const n of notams) {
    const designators = extractDesignators(n.text)
    if (designators.length === 0) continue
    let found = 0
    for (const d of designators) {
      // "ESR22" in a NOTAM covers charted sectors ESR22A, ESR22B, ...; an
      // exact "ESR22A" only its own sector.
      const hits = exact.get(d) ?? (/[A-Z]$/.test(d) ? undefined : byBase.get(d))
      if (!hits || hits.length === 0) continue
      found++
      for (const airspace of hits) {
        let entry = grouped.get(airspace.name)
        if (!entry) {
          entry = { airspaceName: airspace.name, geometry: airspace.geometry, notams: [] }
          grouped.set(airspace.name, entry)
        }
        if (!entry.notams.some(x => x.nmsId === n.nmsId)) entry.notams.push(n)
      }
    }
    if (found === designators.length) matchedNotamIds.add(n.nmsId)
  }
  return { matches: [...grouped.values()], matchedNotamIds }
}

function featureProps(n: NotamItem, radiusNm: number | null) {
  return {
    notamId:        n.id,
    qCode:          n.qCode ?? null,
    nmsId:          n.nmsId,
    text:           n.text,
    effective:      n.effective,
    expires:        n.expires,
    classification: n.classification,
    icaoLocation:   n.icaoLocation,
    radiusNm,
  }
}

export interface NotamMapFeatures {
  circles:  Feature<Polygon>[]
  polygons: Feature<AreaGeometry>[]
  points:   Feature<Point>[]
  /**
   * Obstacle NOTAMs (Q-code OB.. or OL..: new obstacle, obstacle lights out of
   * service): hundreds of windmill/mast pins that bury everything else when
   * zoomed out. Own source, drawn only when zoomed in
   * (NOTAM_OBSTACLE_MIN_ZOOM), so they are culled when zoomed out (about 1:750,000).
   */
  obstacles: Feature<Point>[]
}

/** Map zoom from which obstacle NOTAM pins are drawn (~1:750,000 and closer). */
export const NOTAM_OBSTACLE_MIN_ZOOM = 9

/**
 * Instrument procedure amendments (Q-code PI.. approach, PD.. SID, PA.. STAR):
 * "RNP RWY 27L CHANGE MINIMA" says nothing about where a VFR pilot flies and
 * the pin just sits on the airport. Still listed, just not drawn as a point.
 */
const isProcedure = (n: NotamItem): boolean => /^(?:Q)?P[IDA]/.test((n.qCode ?? '').toUpperCase())

const isObstacle = (n: NotamItem): boolean => {
  const q = (n.qCode ?? '').toUpperCase().replace(/^Q/, '')
  return q.startsWith('OB') || q.startsWith('OL')
}

/** NOTAMs not ruled out by their own schedule for [fromMs, toMs] (see notamSchedule). */
export function notamsInWindow<T extends NotamItem>(notams: readonly T[], fromMs: number, toMs: number): T[] {
  return notams.filter(n => !isOffSchedule(n, fromMs, toMs))
}

export interface NotamTimeWindow {
  /** Window start (ms). NOTAMs whose schedule never touches [from, to] are left off the map. */
  fromMs: number
  toMs: number
}

/** Default look-ahead for "in force soon": flights are short, schedules are by the hour. */
export const NOTAM_MAP_HORIZON_MS = 3 * 3_600_000

export function notamMapFeatures(
  notams: readonly NotamItem[],
  matchedNotamIds: ReadonlySet<string>,
  window?: NotamTimeWindow,
): NotamMapFeatures {
  const circles: Feature<Polygon>[] = []
  const polygons: Feature<AreaGeometry>[] = []
  const points: Feature<Point>[] = []
  const obstacles: Feature<Point>[] = []
  for (const n of notams) {
    // Scheduled NOTAMs (item D / leading E text) that are off for the whole
    // window aren't drawn -- still listed, with an "off schedule" note.
    if (window && isOffSchedule(n, window.fromMs, window.toMs)) continue
    if (n.polygon) {
      polygons.push({ type: 'Feature', geometry: n.polygon, properties: featureProps(n, null) })
    } else if (n.lat !== null && n.lon !== null) {
      if (n.radiusNm !== null && n.radiusNm > 0) {
        if (matchedNotamIds.has(n.nmsId)) continue
        const c = makeCirclePolygon(n.lat, n.lon, n.radiusNm)
        c.properties = featureProps(n, n.radiusNm)
        circles.push(c)
      } else {
        if (isProcedure(n)) continue
        const f: Feature<Point> = { type: 'Feature', geometry: { type: 'Point', coordinates: [n.lon, n.lat] }, properties: featureProps(n, null) }
        ;(isObstacle(n) ? obstacles : points).push(f)
      }
    }
  }
  return { circles, polygons, points, obstacles }
}

/** Highlight layer: charted areas with an active NOTAM. */
export function matchedAirspaceFeatures(matches: readonly MatchedAirspaceNotam[]): Feature<AreaGeometry>[] {
  return matches.map(m => ({ type: 'Feature', geometry: m.geometry, properties: { name: m.airspaceName } }))
}
