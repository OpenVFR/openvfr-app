/**
 * Fuel grades: the codes an aircraft profile lists, their labels, and
 * matching against the fuel codes in the aerodrome data.
 *
 * A profile's list is in order of preference: the first grade is the one the
 * pilot prefers, the others are approved alternatives.
 *
 * Aerodrome data (`fuel` property of the aerodromes GeoJSON) uses codes such
 * as AVGAS, AVGAS_UL91, MOGAS, OCT91-98 (motor gasoline by octane) and A1
 * (jet fuel). Unknown codes never match.
 */
import type { FuelCode } from './types'

export const FUEL_CODES: readonly FuelCode[] = ['AVGAS100LL', 'AVGAS_UL91', 'MOGAS', 'JETA1']

export const FUEL_LABELS: Record<FuelCode, string> = {
  AVGAS100LL: 'AVGAS 100LL',
  AVGAS_UL91: 'AVGAS UL91',
  MOGAS:      'MOGAS',
  JETA1:      'JET A-1',
}

/** Whether one aerodrome fuel code supplies the given grade. */
function supplies(code: string, grade: FuelCode): boolean {
  const c = code.trim().toUpperCase()
  switch (grade) {
    case 'AVGAS100LL': return c === 'AVGAS' || c === '100LL' || c === 'AVGAS_100LL' || c.startsWith('100')
    case 'AVGAS_UL91': return c === 'AVGAS_UL91' || c === 'UL91'
    case 'MOGAS':      return c === 'MOGAS' || c.startsWith('OCT')
    case 'JETA1':      return c === 'A1' || c === 'JETA1' || c === 'JET_A1' || c.startsWith('JET')
  }
}

/** Grades from `wanted` that an aerodrome with fuel codes `aerodromeFuel` sells, in `wanted`'s (preference) order. */
export function matchingFuels(aerodromeFuel: readonly string[], wanted: readonly FuelCode[]): FuelCode[] {
  return wanted.filter(g => aerodromeFuel.some(c => supplies(c, g)))
}

/** True when the aerodrome sells at least one of the wanted grades. */
export function sellsAnyFuel(aerodromeFuel: readonly string[], wanted: readonly FuelCode[]): boolean {
  return matchingFuels(aerodromeFuel, wanted).length > 0
}

/**
 * Position in the preference list of the best grade the aerodrome sells:
 * 0 = the preferred grade, 1 = the second choice, ...; -1 when it sells none.
 */
export function fuelPreferenceRank(aerodromeFuel: readonly string[], wanted: readonly FuelCode[]): number {
  return wanted.findIndex(g => aerodromeFuel.some(c => supplies(c, g)))
}

/** Keep only known codes, in the given (preference) order, without duplicates. */
export function normalizeFuelCodes(v: unknown): FuelCode[] {
  if (!Array.isArray(v)) return []
  const known = new Set<string>(FUEL_CODES)
  const out: FuelCode[] = []
  for (const x of v) {
    if (typeof x !== 'string') continue
    const c = x.trim().toUpperCase()
    if (known.has(c) && !out.includes(c as FuelCode)) out.push(c as FuelCode)
  }
  return out
}

/** "1st", "2nd", "3rd", "4th" for a 0-based preference rank. */
export function preferenceLabel(rank: number): string {
  return ['1st', '2nd', '3rd'][rank] ?? `${rank + 1}th`
}
