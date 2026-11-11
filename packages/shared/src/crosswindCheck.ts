/**
 * Crosswind at the aerodromes where the route takes off or lands (departure,
 * destination, fuel stops) against the aircraft's maximum demonstrated
 * crosswind.
 *
 * Per aerodrome the best runway end is the one with the smallest crosswind
 * among ends without a tailwind (or the smallest crosswind of all when every
 * end has a tailwind). Gusts count: the check uses the gust speed when the
 * report has one. Variable or calm wind is not checked.
 */
import { computeRunwayWind, type RunwayThresholdInput } from './runwayWind'
import type { ParsedWind } from './fetchWx'

export interface LandingPoint {
  icao: string
  /** 'departure' | 'destination' | 'fuel stop' — for the message. */
  role: string
}

export interface CrosswindExceedance {
  icao:        string
  role:        string
  runway:      string
  crosswindKt: number
  limitKt:     number
  /** Wind as reported, e.g. "240/18G28". */
  windText:    string
}

/** Runway thresholds per ICAO from the aerodromes GeoJSON (`runways[].thresholds`). */
export function thresholdsByIcao(fc: { features: { properties: Record<string, unknown> | null }[] }): Map<string, RunwayThresholdInput[]> {
  const out = new Map<string, RunwayThresholdInput[]>()
  for (const f of fc.features) {
    const p = f.properties ?? {}
    const icao = String(p['icao'] ?? '').toUpperCase()
    if (!icao) continue
    let rwys = p['runways']
    if (typeof rwys === 'string') { try { rwys = JSON.parse(rwys) } catch { rwys = [] } }
    if (!Array.isArray(rwys)) continue
    const ths: RunwayThresholdInput[] = []
    for (const r of rwys as { thresholds?: unknown }[]) {
      if (!Array.isArray(r?.thresholds)) continue
      for (const t of r.thresholds as Record<string, unknown>[]) {
        ths.push({
          designator: String(t['designator'] ?? ''),
          mag_brg:    typeof t['mag_brg'] === 'number' ? t['mag_brg'] as number : null,
          true_brg:   typeof t['true_brg'] === 'number' ? t['true_brg'] as number : null,
        })
      }
    }
    if (ths.length > 0) out.set(icao, ths)
  }
  return out
}

function windText(w: ParsedWind): string {
  const dir = w.dirDeg == null ? 'VRB' : String(Math.round(w.dirDeg)).padStart(3, '0')
  return `${dir}/${Math.round(w.speedKt)}${w.gustKt ? `G${Math.round(w.gustKt)}` : ''} kt`
}

export function crosswindExceedances(
  points:      readonly LandingPoint[],
  winds:       ReadonlyMap<string, ParsedWind>,
  thresholds:  ReadonlyMap<string, RunwayThresholdInput[]>,
  limitKt:     number,
): CrosswindExceedance[] {
  if (!(limitKt > 0)) return []
  const out: CrosswindExceedance[] = []
  const seen = new Set<string>()
  for (const pt of points) {
    const icao = pt.icao.toUpperCase()
    if (seen.has(icao)) continue
    seen.add(icao)
    const wind = winds.get(icao)
    const ths = thresholds.get(icao)
    if (!wind || wind.calm || wind.variable || wind.dirDeg == null || !ths) continue
    const speed = Math.max(wind.speedKt, wind.gustKt ?? 0)
    const ends = computeRunwayWind(ths, { ...wind, speedKt: speed })
      .filter(e => e.crosswindKt != null && e.headwindKt != null)
    if (ends.length === 0) continue
    const noTail = ends.filter(e => e.headwindKt! >= 0)
    const pool = noTail.length > 0 ? noTail : ends
    const best = pool.reduce((a, b) => (b.crosswindKt! < a.crosswindKt! ? b : a))
    if (best.crosswindKt! > limitKt) {
      out.push({ icao, role: pt.role, runway: best.designator, crosswindKt: best.crosswindKt!, limitKt, windText: windText(wind) })
    }
  }
  return out
}
