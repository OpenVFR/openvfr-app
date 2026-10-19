/**
 * geoid — height of the geoid (mean sea level) above the WGS-84 ellipsoid,
 * and the correction from GPS ellipsoidal height to altitude AMSL.
 *
 * Why: Android (`Location.getAltitude()`, passed through by expo-location)
 * and the browser Geolocation API report altitude above the WGS-84
 * ELLIPSOID, not above sea level. Over the Nordics the geoid lies 18-38 m
 * above the ellipsoid (EGM96: Stockholm ~23 m, Malmö/Göteborg ~35 m, Oslo
 * ~38 m), so those altitudes read 60-125 ft too high -- the dangerous
 * direction for height above ground, terrain/obstacle and airspace-floor
 * margins. iOS (`CLLocation.altitude`) already reports altitude above mean
 * sea level and must NOT be corrected.
 *
 * Data: EGM96 (public domain, NGA/NASA) on a 0.5 deg grid over Europe
 * (lat 34..72 N, lon 25 W..45 E), see ./geoidGrid.ts and
 * scripts/gen-geoid-grid.mjs. Bilinear interpolation; within 0.4 m of the
 * 15' model for 99 % of the area, 1.4 m worst.
 */

import { GEOID_GRID } from './geoidGrid'

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Base64 to bytes without atob/Buffer (not guaranteed on every runtime). */
function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let bits = 0, acc = 0, o = 0
  for (let i = 0; i < clean.length; i++) {
    const v = B64.indexOf(clean[i]!)
    if (v < 0) continue
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, o)
}

let grid: Int16Array | null = null

function heights(): Int16Array {
  if (!grid) {
    const bytes = decodeBase64(GEOID_GRID.data)
    const n = GEOID_GRID.rows * GEOID_GRID.cols
    grid = new Int16Array(n)
    for (let i = 0; i < n; i++) {
      const v = bytes[2 * i]! | (bytes[2 * i + 1]! << 8)
      grid[i] = v >= 0x8000 ? v - 0x10000 : v
    }
  }
  return grid
}

/**
 * Geoid height above the WGS-84 ellipsoid (m) at lat/lng, or null outside
 * the covered area (then no correction is possible -- callers keep the raw
 * value).
 */
export function geoidHeightM(lat: number, lng: number): number | null {
  const { latMax, lonMin, step, rows, cols } = GEOID_GRID
  const fr = (latMax - lat) / step
  const fc = (lng - lonMin) / step
  if (!(fr >= 0 && fc >= 0 && fr <= rows - 1 && fc <= cols - 1)) return null
  const r = Math.min(Math.floor(fr), rows - 2)
  const c = Math.min(Math.floor(fc), cols - 2)
  const dr = fr - r, dc = fc - c
  const h = heights()
  const at = (rr: number, cc: number) => h[rr * cols + cc]! / 10
  return at(r, c) * (1 - dr) * (1 - dc) + at(r, c + 1) * (1 - dr) * dc + at(r + 1, c) * dr * (1 - dc) + at(r + 1, c + 1) * dr * dc
}

/**
 * Altitude above mean sea level (m) from a GPS height above the ellipsoid.
 * Outside the covered area the input is returned unchanged.
 */
export function ellipsoidToMslM(heightM: number, lat: number, lng: number): number {
  const n = geoidHeightM(lat, lng)
  return n == null ? heightM : heightM - n
}

/**
 * Whether this platform's GPS altitude is above the ellipsoid (and so needs
 * ellipsoidToMslM): Android, and browsers on Android (the Geolocation API
 * passes Android's value through). iOS reports altitude above mean sea
 * level already.
 */
export function gpsAltitudeIsEllipsoidal(platform: { os?: string; userAgent?: string }): boolean {
  if (platform.os) return platform.os === 'android'
  return /android/i.test(platform.userAgent ?? '')
}
