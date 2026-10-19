/**
 * Tripwire for the GPS altitude reference (see ./geoid.ts).
 *
 * The geoid correction assumes what each platform's raw `altitude` means:
 * Android = above the WGS-84 ellipsoid, iOS = above mean sea level. Between
 * the OS and us sits expo-location (apps/native). If an upgrade made its
 * Android `altitude` sea level (e.g. via Android 14's getMslAltitudeMeters /
 * AltitudeConverter) or its iOS `altitude` ellipsoidal, the correction would
 * silently become wrong by 60-125 ft over the Nordics. This test reads the
 * library's native sources and fails on exactly such a change.
 *
 * If it fails after an expo-location upgrade: check what the new version
 * reports, update gpsAltitudeIsEllipsoidal in ./geoid.ts (and its tests),
 * then update the expectations here. The runtime ground check
 * (./gpsAltitudeReference.ts) is the second line of defence.
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

describe('expo-location altitude semantics (assumed by ./geoid.ts)', () => {
  it('is installed (run pnpm install at the repo root)', () => {
    expect(existsSync(join(lib, 'package.json')), `expo-location not found at ${lib}`).toBe(true)
  })

  it('Android: `altitude` is Location.getAltitude() (above the ellipsoid), no MSL conversion', () => {
    const android = filesUnder(join(lib, 'android', 'src'), '.kt').map((f) => readFileSync(f, 'utf8')).join('\n')
    expect(android).toMatch(/altitude\s*=\s*location\.altitude\b/)
    expect(android).not.toMatch(/mslAltitude|MslAltitude|AltitudeConverter/)
  })

  it('iOS: `altitude` is CLLocation.altitude (above mean sea level), not ellipsoidalAltitude', () => {
    const utils = readFileSync(join(lib, 'ios', 'LocationUtils.swift'), 'utf8')
    expect(utils).toMatch(/"altitude":\s*location\.altitude\b/)
    expect(utils).not.toMatch(/"altitude":\s*location\.ellipsoidalAltitude/)
  })
})
