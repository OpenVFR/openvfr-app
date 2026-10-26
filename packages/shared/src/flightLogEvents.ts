/**
 * Events of a stored flight log for a list (the log entry's "Events"), shared by
 * web and native. Builds the log's profile path and the airspace it crosses on
 * demand, so nothing extra is stored. Airspace limits given above ground are
 * used at their raw height here (no terrain is fetched for a list), so an
 * entry into an AGL-limited area can differ slightly from the profile view.
 */

import { buildVirtualRadarProfile } from './virtualRadarCalc'
import { flightLogProfile, flownEvents, type FlightLogTrackPoint, type FlownEvent } from './flightLogProfile'
import type { LogSpeedThresholds } from './flightLogStats'

const NO_FEATURES: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

export function flightLogEvents(
  track: readonly FlightLogTrackPoint[],
  airspace: GeoJSON.FeatureCollection | null,
  thr: LogSpeedThresholds,
  airspaceCeilingFt = Infinity,
): FlownEvent[] {
  const prof = flightLogProfile(track)
  if (!prof) return []
  const bands = airspace
    ? buildVirtualRadarProfile(prof.path, [], airspace, NO_FEATURES, undefined, undefined, airspaceCeilingFt).airspaceBands
    : []
  return flownEvents(prof.points, bands, thr)
}
