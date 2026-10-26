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
): Promise<FlownEvent[]> {
  const t = autoFlyThresholds(aircraft?.takeoffSpeedKts, aircraft?.category)
  const airspace = await loadAirspace().catch(() => null)
  try {
    const track = JSON.parse(log.trackJson || '[]') as FlightLogTrackPoint[]
    return flightLogEvents(track, airspace, { takeoffKts: t.takeoffKts, landedKts: t.landedKts })
  } catch {
    return []
  }
}
