export type RouteWaypoint = {
  lng: number
  lat: number
  /** Short identifier shown on map and in PLOG — set when snapped to a known feature. */
  name?: string
  /** Free-text pilot reminder shown as an alert when this turning point becomes the active leg destination. */
  note?: string
  /** Land and refuel here: the fuel plan starts a new hop with full tanks at this point. */
  fuelStop?: boolean
  /** Field elevation, ft, when the point is an aerodrome (used where the route lands at it). */
  elevationFt?: number
}

function toRad(deg: number) {
  return (deg * Math.PI) / 180
}

/** True bearing in degrees (0–360) from `from` to `to`. */
export function bearingDeg(from: RouteWaypoint, to: RouteWaypoint): number {
  const φ1 = toRad(from.lat)
  const φ2 = toRad(to.lat)
  const Δλ = toRad(to.lng - from.lng)
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

/** The points of a route where the aircraft takes off or lands: departure, points marked as fuel stops, destination. */
export function landingPoints(waypoints: readonly RouteWaypoint[]): { index: number; name: string; role: 'departure' | 'fuel stop' | 'destination' }[] {
  const out: { index: number; name: string; role: 'departure' | 'fuel stop' | 'destination' }[] = []
  waypoints.forEach((w, i) => {
    if (!w.name) return
    if (i === 0) out.push({ index: i, name: w.name, role: 'departure' })
    else if (i === waypoints.length - 1) out.push({ index: i, name: w.name, role: 'destination' })
    else if (w.fuelStop) out.push({ index: i, name: w.name, role: 'fuel stop' })
  })
  return out
}

/**
 * Ground speed (kt) flying a true course at true airspeed `tas` in a wind
 * (`dirDeg` = direction it blows from): the wind triangle with the wind
 * correction angle, never below 10 kt. The one implementation behind the
 * fuel plan and the server briefing's times.
 */
export function groundSpeedKts(tas: number, courseDeg: number, wind?: { dirDeg: number; speedKts: number } | null): number {
  if (!wind || !(wind.speedKts > 0)) return Math.max(10, tas)
  const r = ((wind.dirDeg - courseDeg) * Math.PI) / 180
  const wca = Math.asin(Math.max(-1, Math.min(1, (wind.speedKts * Math.sin(r)) / Math.max(tas, 1))))
  return Math.max(10, tas * Math.cos(wca) - wind.speedKts * Math.cos(r))
}

/** Haversine great-circle distance in nautical miles from `from` to `to`. */
export function distanceNm(from: RouteWaypoint, to: RouteWaypoint): number {
  const R = 3440.065 // Earth radius in NM
  const φ1 = toRad(from.lat)
  const φ2 = toRad(to.lat)
  const Δφ = φ2 - φ1
  const Δλ = toRad(to.lng - from.lng)
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ---------------------------------------------------------------------------
// Magnetic declination — full WMM via the `geomagnetism` package (Apache-2.0)
// Source: NOAA World Magnetic Model, auto-selects the correct epoch for the date.
// Accuracy: <1° globally; well-suited for VFR chart purposes.
// ---------------------------------------------------------------------------
import geomagnetism from 'geomagnetism'

/**
 * Magnetic declination (positive = East) in degrees at the given point.
 * Uses the full WMM via the `geomagnetism` package; accurate to <1°.
 * @param lat  geodetic latitude in degrees
 * @param lng  longitude in degrees
 * @param year decimal year (defaults to current date); converted internally to a Date
 */
export function magDeclination(lat: number, lng: number, year?: number): number {
  let date: Date
  if (year !== undefined) {
    // Convert decimal year (e.g. 2026.3) → JavaScript Date
    const y = Math.floor(year)
    const msInYear = (new Date(y + 1, 0, 1).getTime() - new Date(y, 0, 1).getTime())
    date = new Date(new Date(y, 0, 1).getTime() + (year - y) * msInYear)
  } else {
    date = new Date()
  }
  try {
    const model = geomagnetism.model(date, { allowOutOfBoundsModel: true })
    return model.point([lat, lng]).decl
  } catch {
    return 0
  }
}

/** Magnetic bearing in degrees (0–360) from `from` to `to`, at the midpoint. */
export function magneticBearingDeg(from: RouteWaypoint, to: RouteWaypoint): number {
  const midLat = (from.lat + to.lat) / 2
  const midLng = (from.lng + to.lng) / 2
  const decl = magDeclination(midLat, midLng)
  return (bearingDeg(from, to) - decl + 360) % 360
}

const R_NM = 3440.065  // Earth radius in NM
const D2R  = Math.PI / 180

/**
 * Advance a position by `distNm` NM along `trackDeg` (great-circle).
 * Returns normalised lat/lng.
 */
export function advancePosition(
  lat: number,
  lng: number,
  trackDeg: number,
  distNm: number,
): { lat: number; lng: number } {
  const d    = distNm / R_NM
  const lat1 = lat * D2R
  const lng1 = lng * D2R
  const brng = trackDeg * D2R

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) +
    Math.cos(lat1) * Math.sin(d) * Math.cos(brng),
  )
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    )
  return {
    lat: lat2 * (180 / Math.PI),
    lng: ((lng2 * (180 / Math.PI)) + 540) % 360 - 180,
  }
}
