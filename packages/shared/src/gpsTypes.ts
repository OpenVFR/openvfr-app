/**
 * Shared GPS / flying-mode types used by useGoFlying and GoFlyingPanel.
 */

export type GpsPosition = {
  lat: number
  lng: number
  /** Altitude AMSL in feet (GPS ellipsoidal altitude converted to ft; 0 when unavailable). */
  altFt: number
  /** Ground speed in knots. */
  speedKts: number
  /** True track 0–360°. */
  trackDeg: number
  /** Horizontal accuracy in metres (0 for simulation). */
  accuracy: number
}

export type FlyingMode = 'off' | 'gps' | 'sim' | 'ext'

export type MapOrientation = 'north' | 'track' | 'course'
