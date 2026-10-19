/**
 * Shared GPS / flying-mode types used by useGoFlying and GoFlyingPanel.
 */

export type GpsPosition = {
  lat: number
  lng: number
  /** Altitude AMSL in feet; 0 when unavailable. From GPS, it is already
   *  corrected to mean sea level where the platform reports height above the
   *  WGS-84 ellipsoid (Android, Android browsers: @open-vfr/shared/geoid) --
   *  never feed a raw ellipsoidal value in here. */
  altFt: number
  /** Real GPS only: the altitude exactly as the platform reported it (m,
   *  before any geoid correction), for the ground check in
   *  @open-vfr/shared/gpsAltitudeReference. Not for display. */
  rawAltM?: number
  /** Real GPS only: the platform's vertical accuracy estimate (m), if any. */
  altAccuracyM?: number
  /** Ground speed in knots. */
  speedKts: number
  /** True track 0–360°. */
  trackDeg: number
  /** Horizontal accuracy in metres (0 for simulation). */
  accuracy: number
}

export type FlyingMode = 'off' | 'gps' | 'sim' | 'ext'

export type MapOrientation = 'north' | 'track' | 'course'
