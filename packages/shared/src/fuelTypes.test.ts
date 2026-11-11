import { describe, it, expect } from 'vitest'
import { matchingFuels, sellsAnyFuel, normalizeFuelCodes } from './fuelTypes'

describe('fuel grade matching', () => {
  it('maps aerodrome codes to grades', () => {
    expect(matchingFuels(['AVGAS'], ['AVGAS100LL', 'AVGAS_UL91'])).toEqual(['AVGAS100LL'])
    expect(matchingFuels(['AVGAS_UL91'], ['AVGAS100LL', 'AVGAS_UL91'])).toEqual(['AVGAS_UL91'])
    expect(matchingFuels(['OCT91-98'], ['MOGAS'])).toEqual(['MOGAS'])
    expect(matchingFuels(['A1'], ['JETA1'])).toEqual(['JETA1'])
  })
  it('is false for no data or other grades', () => {
    expect(sellsAnyFuel([], ['AVGAS100LL'])).toBe(false)
    expect(sellsAnyFuel(['A1'], ['AVGAS100LL', 'MOGAS'])).toBe(false)
    expect(sellsAnyFuel(['AVGAS'], [])).toBe(false)
  })
  it('normalizes stored lists', () => {
    expect(normalizeFuelCodes(['mogas', 'AVGAS100LL', 'X', 3, 'MOGAS'])).toEqual(['AVGAS100LL', 'MOGAS'])
    expect(normalizeFuelCodes('AVGAS100LL')).toEqual([])
  })
})
