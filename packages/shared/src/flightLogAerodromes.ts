/**
 * Departure / arrival of a flight log, worked out from its track.
 *
 * Each end of the track is named after the place it is at: an aerodrome
 * within LOG_AERODROME_MAX_NM, else one of the user's own saved places (a
 * farm strip, a private field) within the same distance (logPlaceNear). An
 * end in the air (a recording gap, a GPS loss) or away from both stays blank
 * rather than naming the nearest airfield miles away.
 *
 * Used when a log is recorded (at takeoff and when it closes), to fill logs
 * that were closed without a name (app closed or killed before the log was
 * finished, aerodrome data not loaded yet, GPX imports), and as suggestions
 * when the user renames a log.
 */

/** Longest departure / arrival a user can type (the server allows 64 bytes). */
export const LOG_PLACE_MAX_CHARS = 30

/**
 * A departure / arrival typed by the user: trimmed, inner spaces collapsed,
 * cut to LOG_PLACE_MAX_CHARS. An aerodrome code (2-4 letters / digits, e.g.
 * `esmi`) is upper-cased; anything else (a farm strip's name) is kept as typed.
 */
export function normalizeLogPlace(input: string): string {
  const s = input.replace(/\s+/g, ' ').trim().slice(0, LOG_PLACE_MAX_CHARS).trim()
  return /^[a-z0-9]{2,4}$/i.test(s) ? s.toUpperCase() : s
}

/** An end of the track must be this close to the aerodrome / place. */
export const LOG_AERODROME_MAX_NM = 2
/** This close, the aircraft is on the aerodrome: it wins over a nearer saved place. */
export const LOG_ON_AERODROME_NM = 0.5

export interface LogAerodrome { icao: string; lat: number; lng: number }
/** A user's saved place (user waypoint). */
export interface LogPlace { name: string; lat: number; lng: number }
export interface LogEndPoint { lat: number; lng: number; spdKts: number }

function distNm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180
  const dLat = (bLat - aLat) * rad
  const dLng = (bLng - aLng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2
  return 3440.065 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

function nearest<T extends { lat: number; lng: number }>(
  lat: number, lng: number, items: readonly T[], ok: (t: T) => boolean, maxNm: number,
): { item: T; d: number } | null {
  let best: { item: T; d: number } | null = null
  for (const it of items) {
    if (!ok(it)) continue
    const d = distNm(lat, lng, it.lat, it.lng)
    if (d <= maxNm && (!best || d < best.d)) best = { item: it, d }
  }
  return best
}

/** ICAO code of the nearest aerodrome within `maxNm` (with a code), or ''. */
export function aerodromeNear(lat: number, lng: number, aerodromes: readonly LogAerodrome[], maxNm = LOG_AERODROME_MAX_NM): string {
  return nearest(lat, lng, aerodromes, a => !!a.icao, maxNm)?.item.icao ?? ''
}

/**
 * The name for a point: the nearest aerodrome within LOG_AERODROME_MAX_NM,
 * else the nearest saved place within it. With both in range the aerodrome
 * wins when the point is on it (LOG_ON_AERODROME_NM) or it is the nearer one,
 * so a private strip next to an airfield still gets its own name. '' = none.
 */
export function logPlaceNear(
  lat: number, lng: number, aerodromes: readonly LogAerodrome[], places: readonly LogPlace[] = [],
): string {
  const ad = nearest(lat, lng, aerodromes, a => !!a.icao, LOG_AERODROME_MAX_NM)
  const pl = nearest(lat, lng, places, p => !!p.name.trim(), LOG_AERODROME_MAX_NM)
  if (ad && (!pl || ad.d <= LOG_ON_AERODROME_NM || ad.d <= pl.d)) return ad.item.icao
  return pl ? normalizeLogPlace(pl.item.name) : ''
}

/**
 * Places near a log's start and end (any speed), as suggestions when the
 * user names them by hand.
 */
export function logEndAerodromes(
  track: readonly LogEndPoint[], aerodromes: readonly LogAerodrome[], places: readonly LogPlace[] = [],
): { departure: string; arrival: string } {
  if (track.length === 0) return { departure: '', arrival: '' }
  const first = track[0]!
  const last = track[track.length - 1]!
  return { departure: logPlaceNear(first.lat, first.lng, aerodromes, places), arrival: logPlaceNear(last.lat, last.lng, aerodromes, places) }
}

/**
 * The departure / arrival a log is missing, from its track ends. Returns only
 * the fields it could fill (empty object when nothing to change).
 *
 * Arrival: only when the last point is slower than `landedKts` (on the
 * ground). Departure: a log starts at the takeoff roll, already at takeoff
 * speed, so its first point counts by distance alone.
 */
export function missingLogAerodromes(
  log: { departureIcao?: string; arrivalIcao?: string },
  track: readonly LogEndPoint[],
  aerodromes: readonly LogAerodrome[],
  landedKts: number,
  places: readonly LogPlace[] = [],
): { departureIcao?: string; arrivalIcao?: string } {
  const out: { departureIcao?: string; arrivalIcao?: string } = {}
  if (track.length === 0 || (aerodromes.length === 0 && places.length === 0)) return out
  const first = track[0]!
  const last = track[track.length - 1]!
  if (!log.departureIcao) {
    const name = logPlaceNear(first.lat, first.lng, aerodromes, places)
    if (name) out.departureIcao = name
  }
  if (!log.arrivalIcao && last.spdKts < landedKts) {
    const name = logPlaceNear(last.lat, last.lng, aerodromes, places)
    if (name) out.arrivalIcao = name
  }
  return out
}
