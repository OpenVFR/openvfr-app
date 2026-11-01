/**
 * tapPick: which point feature a map tap meant, when the hit box holds
 * several (an aerodrome and its own reporting points sit a few pixels apart
 * when zoomed out). Used by web MapView and native AviationMap.
 *
 * The map returns hits in drawing order, and reporting points are drawn
 * above aerodromes, so "first hit" always picked the reporting point even
 * when the finger was on the aerodrome. Instead: nearest to the tap, with
 * the distance to an aerodrome divided by AERODROME_WEIGHT because its
 * symbol is about twice as large -- a tap anywhere on it should count.
 */

/** Aerodrome symbols are ~1.7-2x a navaid / reporting point symbol. */
export const AERODROME_WEIGHT = 2

export interface TapCandidate<T> {
  item: T
  lng: number
  lat: number
  isAerodrome: boolean
}

/**
 * Candidates sorted best first. Distances are compared in a local flat
 * projection, which is all a ranking inside a few-pixel box needs.
 * Stable for equal scores (keeps the map's own order).
 */
export function rankTapCandidates<T>(cands: TapCandidate<T>[], tapLng: number, tapLat: number): T[] {
  const cosLat = Math.cos((tapLat * Math.PI) / 180)
  const score = (c: TapCandidate<T>) => {
    const dx = (c.lng - tapLng) * cosLat
    const dy = c.lat - tapLat
    const d = Math.sqrt(dx * dx + dy * dy)
    return c.isAerodrome ? d / AERODROME_WEIGHT : d
  }
  return cands
    .map((c, i) => ({ c, i, s: score(c) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map(x => x.c.item)
}
