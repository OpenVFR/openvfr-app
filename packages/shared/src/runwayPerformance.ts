/**
 * Runway length check: the take-off and landing distance from the aircraft
 * profile (over a 50 ft screen, maximum mass, sea level, standard
 * temperature, paved dry runway), scaled for the aerodrome and compared with
 * its runways.
 *
 * Scaling uses widely taught planning factors, applied together:
 *   - elevation: +10 % per 1,000 ft;
 *   - temperature: +10 % per 10 °C above the standard temperature at the
 *     aerodrome elevation (only when a temperature is known);
 *   - surface: grass or other unpaved +20 % for take-off, +15 % for landing
 *     (dry; wet grass is worse and not modelled);
 *   - a safety factor of 1.33 for take-off and 1.43 for landing.
 * Wind and slope are not modelled. This is a planning aid: the POH's own
 * tables for the day's mass and conditions decide.
 */
import type { AircraftProfileDocType } from './types'

export type RunwayOp = 'takeoff' | 'landing'

export const PERF_FACTORS = {
  perKftElevation: 0.10,
  per10CAboveIsa:  0.10,
  unpavedTakeoff:  0.20,
  unpavedLanding:  0.15,
  safetyTakeoff:   1.33,
  safetyLanding:   1.43,
} as const

export function isPavedSurface(surface: string): boolean {
  const s = surface.toUpperCase()
  return s === 'ASPH' || s === 'CONC' || s === 'BITUM' || s === 'PEM'
}

/** Temperature (°C) from a METAR's temperature/dew point group, or null. */
export function parseMetarTempC(raw: string | null | undefined): number | null {
  if (!raw) return null
  const m = raw.match(/(?:^|\s)(M?\d{2})\/(M?\d{2})?(?=\s|$)/)
  if (!m) return null
  const t = m[1]!
  return t.startsWith('M') ? -Number(t.slice(1)) : Number(t)
}

/** Distance needed on a runway for an operation, metres, or null when the profile has no distance for it. */
export function requiredDistanceM(
  profile: Pick<AircraftProfileDocType, 'takeoffDist50ftM' | 'landingDist50ftM'>,
  op: RunwayOp,
  at: { elevationFt: number; surface: string; tempC?: number | null },
): number | null {
  const base = op === 'takeoff' ? profile.takeoffDist50ftM : profile.landingDist50ftM
  if (!base || base <= 0) return null
  const elev = Math.max(0, at.elevationFt)
  let f = 1 + PERF_FACTORS.perKftElevation * (elev / 1000)
  if (at.tempC != null) {
    const isa = 15 - 1.98 * (elev / 1000)
    const above = at.tempC - isa
    if (above > 0) f *= 1 + PERF_FACTORS.per10CAboveIsa * (above / 10)
  }
  if (!isPavedSurface(at.surface)) f *= 1 + (op === 'takeoff' ? PERF_FACTORS.unpavedTakeoff : PERF_FACTORS.unpavedLanding)
  f *= op === 'takeoff' ? PERF_FACTORS.safetyTakeoff : PERF_FACTORS.safetyLanding
  return Math.round(base * f)
}

export interface RunwayInfo { designator?: string; lengthM: number; surface: string }

export interface RunwayFit {
  op:          RunwayOp
  requiredM:   number
  /** The runway that fits best (largest length / required). */
  runway:      RunwayInfo
  ok:          boolean
}

/**
 * Best runway at an aerodrome for an operation: the one with the most length
 * to spare against what this aircraft needs on its surface. Null when the
 * profile has no distance for the operation or no runway has a length.
 */
export function bestRunwayFit(
  profile: Pick<AircraftProfileDocType, 'takeoffDist50ftM' | 'landingDist50ftM'>,
  op: RunwayOp,
  runways: readonly RunwayInfo[],
  elevationFt: number,
  tempC?: number | null,
): RunwayFit | null {
  let best: RunwayFit | null = null
  for (const r of runways) {
    if (!(r.lengthM > 0)) continue
    const req = requiredDistanceM(profile, op, { elevationFt, surface: r.surface, tempC })
    if (req == null) return null
    const fit = { op, requiredM: req, runway: r, ok: r.lengthM >= req }
    if (!best || r.lengthM / req > best.runway.lengthM / best.requiredM) best = fit
  }
  return best
}

/** True when the aircraft can both land on and take off from one of the runways (no distances set = true). */
export function runwaysAllowStop(
  profile: Pick<AircraftProfileDocType, 'takeoffDist50ftM' | 'landingDist50ftM'>,
  runways: readonly RunwayInfo[],
  elevationFt: number,
): boolean {
  const ops: RunwayOp[] = ['landing', 'takeoff']
  for (const op of ops) {
    const fit = bestRunwayFit(profile, op, runways, elevationFt)
    if (fit && !fit.ok) return false
  }
  return true
}

export interface RunwayPoint { icao: string; role: string; ops: RunwayOp[] }

export interface RunwayShortfall {
  icao:      string
  role:      string
  op:        RunwayOp
  requiredM: number
  runway:    RunwayInfo
  tempC:     number | null
}

/** Runways per ICAO (length, surface) and elevation from the aerodromes GeoJSON. */
export function runwaysByIcao(fc: { features: { properties: Record<string, unknown> | null }[] }): Map<string, { elevationFt: number; runways: RunwayInfo[] }> {
  const out = new Map<string, { elevationFt: number; runways: RunwayInfo[] }>()
  for (const f of fc.features) {
    const p = f.properties ?? {}
    const icao = String(p['icao'] ?? '').toUpperCase()
    if (!icao) continue
    let rwys = p['runways']
    if (typeof rwys === 'string') { try { rwys = JSON.parse(rwys) } catch { rwys = [] } }
    const runways: RunwayInfo[] = Array.isArray(rwys)
      ? (rwys as Record<string, unknown>[]).map(r => ({
          designator: String(r['designator'] ?? ''),
          lengthM:    Number(r['length_m'] ?? 0) || 0,
          surface:    String(r['surface'] ?? '').toUpperCase(),
        }))
      : []
    out.set(icao, { elevationFt: Number(p['elevation_ft'] ?? 0) || 0, runways })
  }
  return out
}

/** Operations at route aerodromes whose best runway is shorter than the aircraft needs. */
export function runwayShortfalls(
  profile: Pick<AircraftProfileDocType, 'takeoffDist50ftM' | 'landingDist50ftM'>,
  points:  readonly RunwayPoint[],
  aerodromes: ReadonlyMap<string, { elevationFt: number; runways: RunwayInfo[] }>,
  tempsC?: ReadonlyMap<string, number>,
): RunwayShortfall[] {
  const out: RunwayShortfall[] = []
  for (const pt of points) {
    const icao = pt.icao.toUpperCase()
    const ad = aerodromes.get(icao)
    if (!ad) continue
    const tempC = tempsC?.get(icao) ?? null
    for (const op of pt.ops) {
      const fit = bestRunwayFit(profile, op, ad.runways, ad.elevationFt, tempC)
      if (fit && !fit.ok) out.push({ icao, role: pt.role, op, requiredM: fit.requiredM, runway: fit.runway, tempC })
    }
  }
  return out
}
