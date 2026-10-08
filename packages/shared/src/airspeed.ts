/**
 * Airspeed conversion shared by web and native.
 *
 * Aircraft profiles and leg speed overrides hold INDICATED airspeed (what the
 * POH and the pilot quote). Time, wind correction and fuel need TRUE airspeed,
 * which is higher with altitude (about +2 % per 1000 ft in ISA). Standard
 * atmosphere only: the real temperature changes TAS by about 1-2 %, which is
 * not worth a per-leg input.
 *
 * IAS is treated as equivalent airspeed: compressibility is negligible at VFR
 * speeds and altitudes, and instrument/position error is not modelled.
 */

const T0_K = 288.15
const LAPSE_C_PER_FT = 1.98 / 1000      // ISA, below the tropopause
const TROPOPAUSE_FT = 36089
const PRESSURE_EXP = 5.2559

/** ISA temperature (°C) at a pressure altitude. */
export function isaTempC(altFt: number): number {
  const h = Math.min(Math.max(altFt, 0), TROPOPAUSE_FT)
  return 15 - LAPSE_C_PER_FT * h
}

/** Density ratio σ at a pressure altitude (ISA). */
export function densityRatio(altFt: number): number {
  const h = Math.min(Math.max(altFt, 0), TROPOPAUSE_FT)
  const isaK = T0_K - LAPSE_C_PER_FT * h
  const pRatio = Math.pow(isaK / T0_K, PRESSURE_EXP)
  return pRatio * (T0_K / isaK)
}

/** True airspeed (kt) from indicated airspeed at a pressure altitude (ISA). */
export function iasToTas(iasKts: number, altFt: number): number {
  if (!(iasKts > 0)) return iasKts
  return iasKts / Math.sqrt(densityRatio(altFt))
}

/** Indicated airspeed (kt) from true airspeed; inverse of iasToTas. */
export function tasToIas(tasKts: number, altFt: number): number {
  if (!(tasKts > 0)) return tasKts
  return tasKts * Math.sqrt(densityRatio(altFt))
}
