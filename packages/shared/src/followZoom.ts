/**
 * Map follow and auto-zoom rules for flying mode (pure, shared by web and
 * native; the apps only apply the result to their camera).
 *
 * - recenterNeeded(): follow in steps instead of on every position tick. The
 *   map is re-issued only after the aircraft has moved a meaningful distance
 *   across the screen, or the map heading is off by a set angle.
 * - chooseAutoZoom(): destination-aware zoom. Zoom in as far as possible while
 *   the aircraft AND the focus point (departure or destination) stay on screen.
 * - createFocusTracker(): picks that focus point from the flight so far and
 *   the planned route.
 * - followCountdownSecs(): seconds left until a panned map returns to the
 *   aircraft.
 *
 * Distances on screen are in density-independent pixels (dp / CSS px).
 */

export interface LatLng { lat: number; lng: number }

/** A panned map returns to following the aircraft after this long. */
export const FOLLOW_RETURN_MS = 15_000
/** In track / course up the aircraft sits this fraction of the screen height below the centre. */
export const FOLLOW_LOOKAHEAD_RATIO = 0.25
/** Heading change that justifies re-orienting the map. */
export const FOLLOW_HEADING_STEP_DEG = 15
/** Roughly 15 mm on a phone, in dp (160 dp per inch). */
const FOLLOW_MIN_STEP_DP = (15 / 25.4) * 160
/** Roughly 20 mm, in dp. */
const AUTO_ZOOM_MARGIN_DP = (20 / 25.4) * 160
/** Widest view auto-zoom uses and the closest it zooms in. */
export const AUTO_ZOOM_PREFERRED = 11
export const AUTO_ZOOM_MAX = 13
/** Zoom step matching a 10% scale change. */
const ZOOM_STEP = Math.log2(1 / 0.9)
/** "At the field" radius, and the radius for having left it. */
export const AT_FIELD_NM = 1
export const NEAR_FIELD_NM = 5

const M_PER_DEG_LAT = 110_574
const NM_M = 1852

export function distNm(a: LatLng, b: LatLng): number {
  const R = 6371008.8
  const toRad = Math.PI / 180
  const dLat = (b.lat - a.lat) * toRad
  const dLng = (b.lng - a.lng) * toRad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2
  return (2 * R * Math.asin(Math.sqrt(h))) / NM_M
}

/** Ground metres per dp at a latitude and (512 px tile) zoom level. */
export function metersPerDp(lat: number, zoom: number): number {
  return (78271.517 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom
}

/** Smallest absolute difference between two bearings, degrees (0..180). */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 540) % 360 - 180)
  return d
}

/** Screen offset (dp, x right / y down) of `p` from `centre` for a map turned so `bearing` points up. */
export function screenOffset(centre: LatLng, p: LatLng, zoom: number, bearing: number): { x: number; y: number } {
  const mpp = metersPerDp(centre.lat, zoom)
  const east = ((p.lng - centre.lng) * Math.cos((centre.lat * Math.PI) / 180) * 111_320) / mpp
  const north = ((p.lat - centre.lat) * M_PER_DEG_LAT) / mpp
  const b = (bearing * Math.PI) / 180
  return { x: east * Math.cos(b) - north * Math.sin(b), y: -(east * Math.sin(b) + north * Math.cos(b)) }
}

export interface FollowSnapshot { lat: number; lng: number; bearing: number }

/**
 * Does following need to move the map now? `last` is where the previous move
 * put the aircraft (null forces a move: follow just resumed, orientation
 * changed...). `targetBearing` is the bearing the map should have.
 */
export function recenterNeeded(opts: {
  last: FollowSnapshot | null
  pos: LatLng
  targetBearing: number
  zoom: number
  viewW: number
  viewH: number
  headingStepDeg?: number
}): boolean {
  const { last, pos, targetBearing, zoom, viewW, viewH } = opts
  if (!last) return true
  const step = opts.headingStepDeg ?? FOLLOW_HEADING_STEP_DEG
  if (angleDiff(last.bearing, targetBearing) >= step) return true
  const mpp = metersPerDp(pos.lat, zoom)
  const dEast = (pos.lng - last.lng) * Math.cos((pos.lat * Math.PI) / 180) * 111_320
  const dNorth = (pos.lat - last.lat) * M_PER_DEG_LAT
  const movedDp = Math.hypot(dEast, dNorth) / mpp
  const threshold = Math.min(0.25 * Math.min(viewW, viewH), FOLLOW_MIN_STEP_DP)
  return movedDp >= threshold
}

export interface AutoZoomChoice {
  zoom: number
  /** Camera centre; null = the aircraft (caller's usual follow centre). */
  centre: LatLng | null
}

/**
 * Zoom in as far as AUTO_ZOOM_MAX while aircraft and focus both stay on screen
 * (inset by a margin). Near the focus the camera centres between the two; away
 * from it the aircraft stays at its usual place and only the focus must fit.
 * `aheadOffsetDp` is how far below the screen centre the aircraft sits (the
 * look-ahead offset). Returns null when nothing fits even at the widest zoom.
 */
export function chooseAutoZoom(opts: {
  pos: LatLng
  focus: LatLng
  near: boolean
  bearing: number
  viewW: number
  viewH: number
  aheadOffsetDp?: number
  preferred?: number
  max?: number
}): AutoZoomChoice | null {
  const { pos, focus, near, bearing, viewW, viewH } = opts
  const off = opts.aheadOffsetDp ?? 0
  const preferred = opts.preferred ?? AUTO_ZOOM_PREFERRED
  const max = opts.max ?? AUTO_ZOOM_MAX
  const margin = Math.min(AUTO_ZOOM_MARGIN_DP, 0.2 * Math.min(viewW, viewH))
  const halfW = viewW / 2 - margin
  const halfH = viewH / 2 - margin
  const mid: LatLng = { lat: (pos.lat + focus.lat) / 2, lng: (pos.lng + focus.lng) / 2 }
  let best: AutoZoomChoice | null = null
  for (let z = preferred; z <= max + 1e-9; z += ZOOM_STEP) {
    let fits: boolean
    if (near) {
      const a = screenOffset(mid, pos, z, bearing)
      const f = screenOffset(mid, focus, z, bearing)
      fits = Math.abs(a.x) <= halfW && Math.abs(a.y) <= halfH && Math.abs(f.x) <= halfW && Math.abs(f.y) <= halfH
    } else {
      const f = screenOffset(pos, focus, z, bearing)
      const fy = f.y + off
      fits = Math.abs(f.x) <= halfW && Math.abs(fy) <= halfH
    }
    if (!fits) {
      // Wider views fit more, narrower fit less: the first miss ends the search.
      break
    }
    best = { zoom: z, centre: near ? mid : null }
  }
  return best
}

export interface FocusInput {
  pos: LatLng
  speedKts: number
  /** Planned route points while it is visible; empty or one point = none. */
  route: LatLng[]
  /** Below this ground speed the aircraft counts as parked (departure is recorded). */
  parkedKts: number
}

export interface FocusResult {
  focus: LatLng
  /** Radius (NM) inside which the aircraft counts as "at" the focus. */
  nearNm: number
  /** Changes when the focus changes (auto-zoom resumes then). */
  key: string
}

export interface FocusTracker {
  update(input: FocusInput): FocusResult | null
  reset(): void
}

const keyOf = (p: LatLng) => `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`

/**
 * Focus point for auto-zoom:
 *  - route, A to B: the destination (or the start when the flight began at the destination);
 *  - route, back to the start (local flight) or no route: the departure point,
 *    close up while still at it (1 NM), then within 5 NM once left.
 */
export function createFocusTracker(): FocusTracker {
  let departure: LatLng | null = null
  let departed = false
  return {
    reset() { departure = null; departed = false },
    update({ pos, speedKts, route, parkedKts }) {
      if (speedKts < parkedKts) { departure = pos; departed = false }
      if (!departure) departure = pos
      if (!departed && distNm(pos, departure) >= NEAR_FIELD_NM) departed = true

      if (route.length >= 2) {
        const start = route[0]
        const finish = route[route.length - 1]
        const local = distNm(start, finish) < AT_FIELD_NM
        if (!local) {
          const focus = distNm(departure, finish) < AT_FIELD_NM ? start : finish
          return { focus, nearNm: NEAR_FIELD_NM, key: keyOf(focus) }
        }
        if (!departed && distNm(pos, departure) < AT_FIELD_NM) return { focus: departure, nearNm: AT_FIELD_NM, key: keyOf(departure) }
        if (departed) return { focus: start, nearNm: NEAR_FIELD_NM, key: keyOf(start) }
        return null
      }
      if (!departed && distNm(pos, departure) < AT_FIELD_NM) return { focus: departure, nearNm: AT_FIELD_NM, key: keyOf(departure) }
      if (departed) return { focus: departure, nearNm: NEAR_FIELD_NM, key: keyOf(departure) }
      return null
    },
  }
}

/** Whole seconds left on the follow-return timer, or null when none is pending. */
export function followCountdownSecs(returnAtMs: number | null, nowMs: number): number | null {
  if (returnAtMs == null) return null
  const left = returnAtMs - nowMs
  return left > 0 ? Math.ceil(left / 1000) : null
}
