// Unit conversion helpers — internal storage is always NM + kts.
// These helpers are used for display only.

export type DistanceUnit = 'nm' | 'km'
export type SpeedUnit    = 'kts' | 'kmh'

export type Units = {
  distance: DistanceUnit
  speed:    SpeedUnit
}

export const DEFAULT_UNITS: Units = { distance: 'nm', speed: 'kts' }

// ── Distance ─────────────────────────────────────────────────────────────────
export function nmToDisplay(nm: number, unit: DistanceUnit): number {
  return unit === 'km' ? nm * 1.852 : nm
}

export function displayToNm(val: number, unit: DistanceUnit): number {
  return unit === 'km' ? val / 1.852 : val
}

export function distLabel(unit: DistanceUnit): string {
  return unit === 'km' ? 'km' : 'NM'
}

// ── Speed ────────────────────────────────────────────────────────────────────
export function ktsToDisplay(kts: number, unit: SpeedUnit): number {
  return unit === 'kmh' ? kts * 1.852 : kts
}

export function displayToKts(val: number, unit: SpeedUnit): number {
  return unit === 'kmh' ? val / 1.852 : val
}

export function speedLabel(unit: SpeedUnit): string {
  return unit === 'kmh' ? 'km/h' : 'kts'
}
