/**
 * gpsAltitude — altitude above mean sea level (AMSL) from one native GPS fix,
 * the same way on iOS and Android.
 *
 * expo-location's `next` API (SDK 58) reports two heights per fix:
 *   - `altitude`: above the WGS-84 ellipsoid, on both platforms;
 *   - `mslAltitude`: above mean sea level as the OS itself computes it
 *     (iOS always, Android 14+ when the device has a value), else null.
 *
 * Preference: the OS's own MSL value; otherwise the ellipsoidal height minus
 * the EGM96 geoid height (./geoid.ts), which is what Android 13 and older need.
 * `ellipsoidReference` is the verdict of the on-ground check
 * (./gpsAltitudeReference.ts): when it finds `altitude` is already sea level
 * (a library change), it is used as it is.
 */

import { ellipsoidToMslM } from './geoid'
import type { GpsAltitudeRef } from './gpsAltitudeReference'

export type GpsAltitudeSource = 'os-msl' | 'geoid' | 'raw'

export interface NativeFixAltitude {
  /** Height above the WGS-84 ellipsoid (m), or null. */
  altitude: number | null
  /** Height above mean sea level as the OS reports it (m), or null. */
  mslAltitude: number | null
  lat: number
  lng: number
}

export function mslAltitudeFromFix(
  fix: NativeFixAltitude,
  altitudeReference: GpsAltitudeRef = 'ellipsoid',
): { mslM: number; source: GpsAltitudeSource } | null {
  if (fix.mslAltitude != null && Number.isFinite(fix.mslAltitude)) return { mslM: fix.mslAltitude, source: 'os-msl' }
  if (fix.altitude == null || !Number.isFinite(fix.altitude)) return null
  if (altitudeReference === 'msl') return { mslM: fix.altitude, source: 'raw' }
  return { mslM: ellipsoidToMslM(fix.altitude, fix.lat, fix.lng), source: 'geoid' }
}
