/**
 * baroAltitude — source-agnostic barometric altitude math + altitude-tier
 * combination logic. Shared between the internal phone barometer and the
 * external BlueFly Vario (BLE) — both feed raw pressure readings through
 * the same ISA/QNH formula here rather than duplicating it.
 *
 * See native/docs/ble-vario-plan.md §0/§1 for the full design rationale.
 */

const FT_PER_M = 3.28084

/**
 * Convert barometric pressure (Pa) to altitude (metres) using the
 * International Standard Atmosphere model, corrected for local QNH.
 *
 * qnhHpa defaults to 1013.25 hPa (ISA standard datum) — passing the
 * default is equivalent to computing uncorrected pressure altitude.
 */
export function pressureToAltitudeM(pressurePa: number, qnhHpa = 1013.25): number {
  const qnhPa = qnhHpa * 100
  return 44301.59796 * (1 - Math.pow(pressurePa / qnhPa, 0.190295))
}

export function pressureToAltitudeFt(pressurePa: number, qnhHpa = 1013.25): number {
  return pressureToAltitudeM(pressurePa, qnhHpa) * FT_PER_M
}

/**
 * Inverse of pressureToAltitudeM: given a raw station pressure reading and
 * the *known* true elevation (metres AMSL) at which it was taken, derive
 * the QNH (hPa) that would make that pressure/altitude pair consistent —
 * i.e. "what sea-level-equivalent pressure explains this reading at this
 * known elevation". Lets a barometric source (BlueFly Vario, internal baro)
 * be self-calibrated against a known aerodrome field elevation, with no
 * METAR/network dependency and no GPS vertical-accuracy error (unlike
 * deriving QNH from GPS altitude instead of a known ground elevation).
 */
export function qnhFromStationPressure(pressurePa: number, elevationM: number): number {
  const qnhPa = pressurePa / Math.pow(1 - elevationM / 44301.59796, 1 / 0.190295)
  return qnhPa / 100
}

// ── Altitude source tiers ────────────────────────────────────────────────────

export type AltitudeTier = 'gps' | 'baro-internal' | 'baro-vario'

export type AltitudeSourceInput = {
  gpsAltFt: number | null
  /** Internal phone barometer, tier 1 — raw pressure only, no vario. */
  internalBaroPressureHpa: number | null
  /** Filtered vertical speed from the internal barometer (ft/min), if available. */
  internalBaroVsFtMin?: number | null
  /**
   * External BlueFly Vario, tier 2 — already-converted altitude + vertical
   * speed (the BlueFly firmware applies its own Kalman filtering; we don't
   * re-derive altitude from its raw pressure a second time here).
   */
  varioAltFt: number | null
  varioVsFtMin: number | null
  /** QNH used to correct internalBaroPressureHpa. Vario altitude is assumed
   *  already QNH-corrected by the caller (see blueflyVario.ts). */
  qnhHpa: number
  /** See AltitudeSourceResult.qnhCalibrated. Defaults to true when omitted. */
  qnhCalibrated?: boolean
}

export type AltitudeSourceResult = {
  tier:    AltitudeTier
  altFt:   number | null
  /** Populated for the barometric tiers (filtered); null for GPS. */
  vsFtMin: number | null
  /** QNH actually in effect for this reading (echoes the input) — lets the
   *  UI show "what QNH is this altitude computed against" alongside the
   *  altitude itself, without a caller having to separately track it. */
  qnhHpa: number
  /** false when qnhHpa is an unverified fallback (auto-QNH on but no recent
   *  METAR available) — the UI flags such altitudes as uncalibrated. */
  qnhCalibrated: boolean
}

/**
 * Pick the best available altitude source: BlueFly Vario > internal
 * barometer > GPS. Never fails — always returns a result, falling all the
 * way back to raw GPS altitude (or null altitude if GPS itself has none
 * yet) when nothing barometric is present.
 */
export function pickBestAltitudeSource(input: AltitudeSourceInput): AltitudeSourceResult {
  if (input.varioAltFt != null) {
    return { tier: 'baro-vario', altFt: input.varioAltFt, vsFtMin: input.varioVsFtMin ?? null, qnhHpa: input.qnhHpa, qnhCalibrated: true }
  }
  if (input.internalBaroPressureHpa != null) {
    return {
      tier:    'baro-internal',
      altFt:   pressureToAltitudeFt(input.internalBaroPressureHpa * 100, input.qnhHpa),
      vsFtMin: input.internalBaroVsFtMin ?? null,
      qnhHpa:  input.qnhHpa,
      qnhCalibrated: input.qnhCalibrated ?? true,
    }
  }
  return { tier: 'gps', altFt: input.gpsAltFt, vsFtMin: null, qnhHpa: input.qnhHpa, qnhCalibrated: true }
}
