/**
 * Tripwire for the GPS altitude semantics of expo-location's `next` API
 * (see ./gpsAltitude.ts and ./geoid.ts).
 *
 * The app relies on two things per native fix:
 *   - `altitude` is the height above the WGS-84 ELLIPSOID on both platforms
 *     (so the EGM96 geoid correction applies when the OS has no sea-level
 *     value);
 *   - `mslAltitude` is the OS's own height above mean sea level, or null.
 * If an expo-location upgrade changed either (say `altitude` became sea
 * level), the geoid correction would silently be wrong by 60-125 ft over the
 * Nordics. This test reads the library's native sources and fails on exactly
 * such a change. The runtime ground check (./gpsAltitudeReference.ts) is the
 * second line of defence.
 *
 * If it fails after an expo-location upgrade: check what the new version
 * reports, update ./gpsAltitude.ts (and its tests), then the expectations here.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '..', '..', '..', 'apps', 'native', 'node_modules', 'expo-location')

function filesUnder(dir: string, ext: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, ext))
    else if (p.endsWith(ext)) out.push(p)
  }
  return out
}

describe('expo-location `next` altitude semantics (assumed by ./gpsAltitude.ts)', () => {
  it('is installed (run pnpm install at the repo root)', () => {
    expect(existsSync(join(lib, 'package.json')), `expo-location not found at ${lib}`).toBe(true)
  })

  it('Android: `altitude` is Location.getAltitude() (ellipsoid); `mslAltitude` is Android 14 getMslAltitudeMeters', () => {
    const records = readFileSync(join(lib, 'android', 'src', 'main', 'java', 'expo', 'modules', 'location', 'next', 'LocationRecords.kt'), 'utf8')
    expect(records).toMatch(/altitude\s*=\s*if \(hasAltitude\(\)\) \{\s*altitude\s*\}/)
    expect(records).toMatch(/mslAltitude\s*=\s*mslAltitude\(\)/)
    expect(records).toMatch(/hasMslAltitude\(\)\)\s*\{\s*mslAltitudeMeters/)
    // `altitude` must never be fed from the converter.
    const next = filesUnder(join(lib, 'android', 'src'), '.kt').map((f) => readFileSync(f, 'utf8')).join('\n')
    expect(next).not.toMatch(/AltitudeConverter/)
  })

  it('iOS: `altitude` is CLLocation.ellipsoidalAltitude; `mslAltitude` is CLLocation.altitude (sea level)', () => {
    const pos = readFileSync(join(lib, 'ios', 'next', 'Position', 'Position.swift'), 'utf8')
    expect(pos).toMatch(/altitude:\s*verticalAccuracy >= 0 \? ellipsoidalAltitude : nil/)
    expect(pos).toMatch(/mslAltitude:\s*verticalAccuracy >= 0 \? altitude : nil/)
  })

  it('exposes the AIRBORNE profile used for tracking', () => {
    const profile = readFileSync(join(lib, 'ios', 'next', 'Profile.swift'), 'utf8')
    expect(profile).toMatch(/case airborne/)
  })
})
