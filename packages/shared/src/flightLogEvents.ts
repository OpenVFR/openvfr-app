/**
 * Events of a stored flight log for a list (the log entry's "Events"), shared by
 * web and native. Builds the log's profile path and the airspace it crosses on
 * demand, so nothing extra is stored. Airspace limits given above ground are
 * used at their raw height here (no terrain is fetched for a list), so an
 * entry into an AGL-limited area can differ slightly from the profile view.
 */

import { buildVirtualRadarProfile, EMPTY_FEATURES } from './virtualRadarCalc'
import { flightLogProfile, flownEvents, type FlightLogTrackPoint, type FlownEvent } from './flightLogProfile'
import type { LogSpeedThresholds } from './flightLogStats'
import { autoFlyThresholds } from './autoFlyDetect'
import { logPlaceNear, type LogAerodrome, type LogPlace } from './flightLogAerodromes'

/** Aerodromes and the user's saved places, for naming where a take-off or landing happened. */
export interface EventNaming { aerodromes: readonly LogAerodrome[]; places?: readonly LogPlace[] }

/**
 * Name the places of take-offs, landings and touch-and-goes ("Landing at ESMS",
 * "Takeoff from my farm strip"), the same rules as a log's departure and arrival
 * (nearest aerodrome within 2 NM, else a saved place). An event away from both
 * keeps its plain label. Returns new events; the input is not changed.
 */
export function nameFlownEvents(events: readonly FlownEvent[], naming: EventNaming | null | undefined): FlownEvent[] {
  if (!naming) return [...events]
  return events.map((e) => {
    if (e.kind !== 'takeoff' && e.kind !== 'landing' && e.kind !== 'touch-and-go') return e
    const place = logPlaceNear(e.point.lat, e.point.lng, naming.aerodromes, naming.places ?? [])
    return place ? { ...e, label: `${e.label} ${e.kind === 'takeoff' ? 'from' : 'at'} ${place}` } : e
  })
}

export function flightLogEvents(
  track: readonly FlightLogTrackPoint[],
  airspace: GeoJSON.FeatureCollection | null,
  thr: LogSpeedThresholds,
  airspaceCeilingFt = Infinity,
): FlownEvent[] {
  const prof = flightLogProfile(track)
  if (!prof) return []
  const bands = airspace
    ? buildVirtualRadarProfile(prof.path, [], airspace, EMPTY_FEATURES, undefined, undefined, airspaceCeilingFt).airspaceBands
    : []
  return flownEvents(prof.points, bands, thr)
}

/**
 * Events of a stored log as the log list shows them: take-off / landed speeds
 * from the log's aircraft (else its category's default, the same rules as
 * the log statistics), the airspace through the platform's loader (null when
 * unavailable: events without airspace entries). Never rejects: an
 * unreadable track gives no events.
 */
export async function flightLogEventsForLog(
  log: { trackJson: string },
  aircraft: { takeoffSpeedKts?: number | null; category?: string } | null | undefined,
  loadAirspace: () => Promise<GeoJSON.FeatureCollection | null>,
  /** Aerodromes and saved places to name take-offs and landings with; null / absent / failing: plain labels. */
  loadNaming?: () => Promise<EventNaming | null>,
): Promise<FlownEvent[]> {
  const t = autoFlyThresholds(aircraft?.takeoffSpeedKts, aircraft?.category)
  const [airspace, naming] = await Promise.all([
    loadAirspace().catch(() => null),
    loadNaming ? loadNaming().catch(() => null) : Promise.resolve(null),
  ])
  try {
    const track = JSON.parse(log.trackJson || '[]') as FlightLogTrackPoint[]
    return nameFlownEvents(flightLogEvents(track, airspace, { takeoffKts: t.takeoffKts, landedKts: t.landedKts }), naming)
  } catch {
    return []
  }
}
