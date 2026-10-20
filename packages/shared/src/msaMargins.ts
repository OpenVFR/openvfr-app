/**
 * Safety margins used by the minimum safe altitude (MSA) line, the
 * below-MSA warnings and the automatic cruise level for new legs.
 * One definition so web, native and every consumer agree; the user settings
 * (when plumbed) override these defaults.
 */

export type MsaMargins = {
  /** Half-width either side of the route that terrain is checked over (NM). */
  abeamNm: number
  /** Clearance above the highest terrain in that corridor (ft). */
  terrainClearanceFt: number
  /** Clearance above the highest obstacle tip in that corridor (ft). */
  obstacleClearanceFt: number
}

/**
 * Defaults and limits follow the reference planner's warning thresholds
 * (WarningThresholdOptions): vertical terrain clearance 800 ft, vertical
 * obstacle clearance 1000 ft, each 300-2000 ft; abeam distance 5 NM (its
 * obstacle value; it uses 4 NM for terrain, we use one abeam for both) in 1-10 NM.
 */
export const DEFAULT_MSA_MARGINS: MsaMargins = {
  abeamNm: 5.0,
  terrainClearanceFt: 800,
  obstacleClearanceFt: 1000,
}

export const MSA_ABEAM_RANGE_NM = [1, 10] as const
export const MSA_CLEARANCE_RANGE_FT = [300, 2000] as const

/** Fill gaps (and reject nonsense) in a partial / stored margins object. */
export function resolveMsaMargins(m?: Partial<MsaMargins> | null): MsaMargins {
  const pick = (v: number | undefined, d: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d
  return {
    abeamNm: pick(m?.abeamNm, DEFAULT_MSA_MARGINS.abeamNm, ...MSA_ABEAM_RANGE_NM),
    terrainClearanceFt: pick(m?.terrainClearanceFt, DEFAULT_MSA_MARGINS.terrainClearanceFt, ...MSA_CLEARANCE_RANGE_FT),
    obstacleClearanceFt: pick(m?.obstacleClearanceFt, DEFAULT_MSA_MARGINS.obstacleClearanceFt, ...MSA_CLEARANCE_RANGE_FT),
  }
}
