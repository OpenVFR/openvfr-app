/**
 * Obstacle and landmark heights for the Virtual Radar and the MSA.
 *
 * Most structures in the data have no height: 94 % of wind turbines, 78 % of
 * OpenAIP towers, 97 % of OSM masts (measured on the live Swedish files). An
 * unknown height used to mean "tip = ground", i.e. the structure silently did
 * not exist for the MSA. We now assume a typical height per kind, mark it as
 * an estimate (dashed outline on the chart) and use it as a conservative
 * floor. The reference planner does the same with one figure (300 ft).
 *
 * Estimates are the medians of the known heights in the Swedish data, rounded,
 * with 91 m (300 ft, the reference planner's figure) for generic masts.
 */

export const ESTIMATED_HEIGHT_M: Readonly<Record<string, number>> = {
  wind_turbine: 135,
  tower: 91,
  mast: 91,
  chimney: 55,
  building: 40,
  water_tower: 30,
  church: 25,
  windmill: 20,
}
/** Kinds not listed above. */
export const DEFAULT_ESTIMATED_HEIGHT_M = 60

export const FT_PER_M = 3.28084

export type EffectiveHeight = { heightM: number; estimated: boolean }

/** The height to use for an obstacle/landmark: the known one, else the estimate. */
export function effectiveHeight(kind: string, knownHeightM: number | null | undefined): EffectiveHeight {
  const h = Number(knownHeightM)
  if (Number.isFinite(h) && h > 0) return { heightM: h, estimated: false }
  return { heightM: ESTIMATED_HEIGHT_M[kind] ?? DEFAULT_ESTIMATED_HEIGHT_M, estimated: true }
}

const KIND_LABEL: Record<string, string> = {
  wind_turbine: 'Turbine', tower: 'Tower', mast: 'Mast', building: 'Building', chimney: 'Chimney',
  water_tower: 'Water tower', church: 'Church', windmill: 'Windmill',
}

/**
 * Short label for the obstacle that sets the MSA: its name (OpenAIP names can
 * be long codes, so trimmed), else its kind, with the tip altitude and a mark
 * when the height is only an estimate: `Älvsborgsbron 1,096 ft`, `Turbine 944 ft (est.)`.
 */
export function limitingObstacleLabel(kind: string, name: string | undefined, tipFt: number, estimated: boolean): string {
  const clean = (name ?? '').replace(/^[\w-]*\d[\w-]*\s*-\s*/, '').trim()
  const base = clean ? (clean.length > 18 ? clean.slice(0, 17).trimEnd() + '…' : clean) : (KIND_LABEL[kind] ?? 'Obstacle')
  return `${base} ${tipFt.toLocaleString('en-US')} ft${estimated ? ' (est.)' : ''}`
}

type ObstacleLike = { distNm: number; kind: string; elevationFt: number; heightM: number }
type LandmarkLike = { distNm: number; kind: string; heightM?: number }

/**
 * Tip altitude (ft AMSL) of every obstacle and landmark along the route, for
 * the MSA, the auto cruise level and the "limiting obstacle" marker. The
 * result is shaped for computeMsaProfile's obstacle argument (`elevationFt`
 * there means the TIP).
 *
 *  - Obstacle: its surveyed ground elevation (or the terrain, if higher) plus
 *    its height.
 *  - Landmark: the terrain at its position plus its height.
 *  - A structure without a known height gets the per-kind estimate.
 */
export function obstacleTipsForMsa(
  obstacles: readonly ObstacleLike[],
  landmarks: readonly LandmarkLike[],
  terrainFt: (distNm: number) => number,
): { distNm: number; elevationFt: number; estimated: boolean }[] {
  const out: { distNm: number; elevationFt: number; estimated: boolean }[] = []
  for (const o of obstacles) {
    const base = Math.max(o.elevationFt, terrainFt(o.distNm), 0)
    const h = effectiveHeight(o.kind, o.heightM)
    out.push({ distNm: o.distNm, elevationFt: Math.round(base + h.heightM * FT_PER_M), estimated: h.estimated })
  }
  for (const l of landmarks) {
    const base = Math.max(0, terrainFt(l.distNm))
    const h = effectiveHeight(l.kind, l.heightM)
    out.push({ distNm: l.distNm, elevationFt: Math.round(base + h.heightM * FT_PER_M), estimated: h.estimated })
  }
  return out
}
