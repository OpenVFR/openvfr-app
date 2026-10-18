/**
 * Picking the snap target while a route point is dragged (web MapView.tsx,
 * native AviationMap.tsx). Both apps query the map for features near the
 * drop point; this module decides which one the live preview snaps to and
 * how the disambiguation picker orders them.
 *
 * Rule: the nearest aerodrome wins over any nearer non-aerodrome, because
 * an aerodrome is almost always what the user means when one is within
 * reach. Otherwise the nearest feature wins.
 */

export type SnapChoiceCandidate = {
  /** Kind badge, e.g. 'AD', 'VOR', 'RP', 'OBS', 'PT'. */
  kind: string
  waypoint: { lat: number; lng: number }
}

const AERODROME_KIND = 'AD'
/** The "drop exactly here" entry; never a snap target. */
const CUSTOM_POINT_KIND = 'PT'

/** Squared planar distance in degrees, longitude scaled for latitude. Only
 *  used to rank candidates a few screen points apart, so the flat-earth
 *  approximation is fine. */
function distSq(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const k = Math.cos((a.lat * Math.PI) / 180)
  const dx = (a.lng - b.lng) * k
  const dy = a.lat - b.lat
  return dx * dx + dy * dy
}

/** Index of the candidate the drag preview should snap to, or -1 when
 *  there is nothing to snap to. */
export function chooseSnapTarget<T extends SnapChoiceCandidate>(
  candidates: readonly T[],
  at: { lat: number; lng: number },
): number {
  let best = -1
  let bestD = Infinity
  let bestAd = -1
  let bestAdD = Infinity
  candidates.forEach((c, i) => {
    if (c.kind === CUSTOM_POINT_KIND) return
    const d = distSq(at, c.waypoint)
    if (d < bestD) { bestD = d; best = i }
    if (c.kind === AERODROME_KIND && d < bestAdD) { bestAdD = d; bestAd = i }
  })
  return bestAd >= 0 ? bestAd : best
}

/** Picker order: aerodromes first, then by distance from the drop point;
 *  a trailing custom-point entry stays last. */
export function sortSnapCandidates<T extends SnapChoiceCandidate>(
  candidates: readonly T[],
  at: { lat: number; lng: number },
): T[] {
  const rank = (c: T) => (c.kind === CUSTOM_POINT_KIND ? 2 : c.kind === AERODROME_KIND ? 0 : 1)
  return [...candidates].sort((a, b) =>
    rank(a) - rank(b) || distSq(at, a.waypoint) - distSq(at, b.waypoint))
}

/** Text for the hint shown above the live snap target: name, kind and how
 *  many other nearby candidates the picker would offer on release. */
export function snapHintText(
  target: { kind: string; waypoint: { name?: string } },
  otherCount: number,
): string {
  const name = target.waypoint.name ?? target.kind
  const base = name === target.kind ? name : `${name} · ${target.kind}`
  return otherCount > 0 ? `${base} (+${otherCount})` : base
}

/** Positions closer than this count as the same point. Map queries return
 *  tile-quantised coordinates that differ by a few metres to tens of metres
 *  between zoom levels, so the obstacle a waypoint was snapped to does not
 *  compare equal to the waypoint's own stored position; a distance test is
 *  needed, not equality. */
const SAME_POINT_M = 30

function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const k = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180)
  return Math.hypot((a.lng - b.lng) * k * 111_320, (a.lat - b.lat) * 110_540)
}

/** Dropping a route point onto the point before or after it removes it
 *  from the route instead of creating a zero-length leg. Returns the
 *  index of the neighbour the drop landed on, or -1. */
export function neighbourAtDrop(
  waypoints: readonly { lat: number; lng: number }[],
  wpIndex: number,
  drop: { lat: number; lng: number },
): number {
  for (const i of [wpIndex - 1, wpIndex + 1]) {
    const w = waypoints[i]
    if (w && metresBetween(w, drop) <= SAME_POINT_M) return i
  }
  return -1
}
