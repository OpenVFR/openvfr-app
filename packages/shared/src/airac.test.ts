import { describe, it, expect } from 'vitest'
import { currentAiracCycle, airacIdentToMs, isAiracOutdated, airacEffectiveMs, findOutdatedAirac } from './airac'

const d = (y: number, m: number, day: number, h = 12) => Date.UTC(y, m - 1, day, h)

describe('currentAiracCycle', () => {
  it('matches published effective dates', () => {
    expect(currentAiracCycle(d(2025, 1, 23, 0))).toBe('2501')
    expect(currentAiracCycle(d(2025, 1, 22))).toBe('2413')
    expect(currentAiracCycle(d(2025, 2, 20))).toBe('2502')
    expect(currentAiracCycle(d(2025, 6, 12))).toBe('2506')
    expect(currentAiracCycle(d(2024, 1, 25))).toBe('2401')
    expect(currentAiracCycle(d(2023, 1, 26))).toBe('2301')
  })
  it('handles a 14-cycle year (2020)', () => {
    expect(currentAiracCycle(d(2020, 12, 31))).toBe('2014')
    expect(currentAiracCycle(d(2021, 1, 28))).toBe('2101')
  })
  it('2026 has 13 cycles', () => {
    expect(currentAiracCycle(d(2026, 1, 22))).toBe('2601')
    expect(currentAiracCycle(d(2026, 12, 24))).toBe('2613')
    expect(currentAiracCycle(d(2027, 1, 21))).toBe('2701')
  })
})

describe('airacIdentToMs', () => {
  it('round-trips with currentAiracCycle', () => {
    for (const id of ['2014', '2101', '2413', '2501', '2506', '2613', '2701']) {
      expect(currentAiracCycle(airacIdentToMs(id)!)).toBe(id)
    }
  })
  it('rejects nonexistent/malformed identifiers', () => {
    expect(airacIdentToMs('2514')).toBeNull() // 2025 only has 13
    expect(airacIdentToMs('2500')).toBeNull()
    expect(airacIdentToMs('25')).toBeNull()
    expect(airacIdentToMs('abcd')).toBeNull()
  })
})

describe('isAiracOutdated', () => {
  const now = d(2025, 6, 20) // cycle 2506 in force
  it('current cycle is not outdated', () => expect(isAiracOutdated('2506', now)).toBe(false))
  it('next cycle (published ahead) is not outdated', () => expect(isAiracOutdated('2507', now)).toBe(false))
  it('previous cycle is outdated', () => expect(isAiracOutdated('2505', now)).toBe(true))
  it('unparseable is not provably outdated', () => expect(isAiracOutdated('x', now)).toBe(false))
  it('effective date is 00:00Z', () => expect(airacEffectiveMs(now)).toBe(Date.UTC(2025, 5, 12)))
})

describe('findOutdatedAirac', () => {
  const now = d(2025, 6, 20)
  it('lists only superseded airspace cycles, sorted', () => {
    const m = { countries: {
      se: { airspace: { airac_cycle: '2505' } },
      dk: { airspace: { airac_cycle: '2504' }, obstacles: {} },
      no: { airspace: { airac_cycle: '2506' } },
      fi: { obstacles: { airac_cycle: '2401' } },
    } }
    expect(findOutdatedAirac(m, now)).toEqual([{ country: 'dk', cycle: '2504' }, { country: 'se', cycle: '2505' }])
  })
  it('null manifest', () => expect(findOutdatedAirac(null, now)).toEqual([]))
})
