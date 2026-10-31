/**
 * Departure / arrival aerodrome of a flight log, worked out from its track.
 *
 * A log normally gets them while recording (the aerodrome nearest the
 * aircraft at takeoff and at landing). That fails when the log is not closed
 * normally (app closed or killed before the park timer ran: the log is then
 * finished at the next start without a landing aerodrome), or when no
 * aerodrome data was loaded at that moment. These helpers fill what is
 * missing from the track's first and last points instead, but only where the
 * aircraft was on the ground next to an aerodrome: an end in the air (a
 * recording gap, a GPS loss) or in a field stays blank rather than naming the
 * nearest airfield miles away.
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

/** An end of the track must be this close to the aerodrome reference point. */
export const LOG_AERODROME_MAX_NM = 2

export interface LogAerodrome { icao: string; lat: number; lng: number }
export interface LogEndPoint { lat: number; lng: number; spdKts: number }

function distNm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180
  const dLat = (bLat - aLat) * rad
  const dLng = (bLng - aLng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2
  return 3440.065 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

/** ICAO code of the nearest aerodrome within `maxNm` (with a code), or ''. */
export function aerodromeNear(lat: number, lng: number, aerodromes: readonly LogAerodrome[], maxNm = LOG_AERODROME_MAX_NM): string {
  let best = ''
  let bestD = maxNm
  for (const a of aerodromes) {
    if (!a.icao) continue
    const d = distNm(lat, lng, a.lat, a.lng)
    if (d <= bestD) { bestD = d; best = a.icao }
  }
  return best
}

/**
 * Aerodromes near a log's start and end (within LOG_AERODROME_MAX_NM, any
 * speed), as suggestions when the user names them by hand.
 */
export function logEndAerodromes(
  track: readonly LogEndPoint[], aerodromes: readonly LogAerodrome[],
): { departure: string; arrival: string } {
  if (track.length === 0) return { departure: '', arrival: '' }
  const first = track[0]!
  const last = track[track.length - 1]!
  return { departure: aerodromeNear(first.lat, first.lng, aerodromes), arrival: aerodromeNear(last.lat, last.lng, aerodromes) }
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
): { departureIcao?: string; arrivalIcao?: string } {
  const out: { departureIcao?: string; arrivalIcao?: string } = {}
  if (track.length === 0 || aerodromes.length === 0) return out
  const first = track[0]!
  const last = track[track.length - 1]!
  if (!log.departureIcao) {
    const icao = aerodromeNear(first.lat, first.lng, aerodromes)
    if (icao) out.departureIcao = icao
  }
  if (!log.arrivalIcao && last.spdKts < landedKts) {
    const icao = aerodromeNear(last.lat, last.lng, aerodromes)
    if (icao) out.arrivalIcao = icao
  }
  return out
}
