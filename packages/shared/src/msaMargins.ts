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

export const DEFAULT_MSA_MARGINS: MsaMargins = {
  abeamNm: 5.0,
  terrainClearanceFt: 1000,
  obstacleClearanceFt: 500,
}

/** Fill gaps (and reject nonsense) in a partial / stored margins object. */
export function resolveMsaMargins(m?: Partial<MsaMargins> | null): MsaMargins {
  const pick = (v: number | undefined, d: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d
  return {
    abeamNm: pick(m?.abeamNm, DEFAULT_MSA_MARGINS.abeamNm, 0, 25),
    terrainClearanceFt: pick(m?.terrainClearanceFt, DEFAULT_MSA_MARGINS.terrainClearanceFt, 0, 5000),
    obstacleClearanceFt: pick(m?.obstacleClearanceFt, DEFAULT_MSA_MARGINS.obstacleClearanceFt, 0, 5000),
  }
}
