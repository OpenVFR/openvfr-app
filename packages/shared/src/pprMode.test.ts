import { describe, it, expect } from 'vitest'
import { pprBadge, pprExplain, pprModeOf, pprSentence, pprSuffix } from './pprMode'

describe('pprModeOf', () => {
  it('uses ppr_mode when it is one of the four states', () => {
    for (const m of ['always', 'conditional', 'none', 'unknown'] as const) expect(pprModeOf({ ppr: false, ppr_mode: m })).toBe(m)
  })
  it('falls back to the boolean for data without ppr_mode: true is always, the rest unknown', () => {
    expect(pprModeOf({ ppr: true })).toBe('always')
    expect(pprModeOf({ ppr: false })).toBe('unknown')
    expect(pprModeOf({})).toBe('unknown')
    expect(pprModeOf(null)).toBe('unknown')
  })
  it('ignores a ppr_mode it does not know', () => {
    expect(pprModeOf({ ppr: true, ppr_mode: 'sometimes' })).toBe('always')
  })
})

describe('badge and explanation', () => {
  it('shows PPR, PPR* or nothing', () => {
    expect(pprBadge('always')).toBe('PPR')
    expect(pprBadge('conditional')).toBe('PPR*')
    expect(pprBadge('none')).toBeNull()
    expect(pprBadge('unknown')).toBeNull()
  })
  it('explains every state', () => {
    expect(pprExplain('conditional')).toMatch(/some cases/)
    expect(pprExplain('always')).toMatch(/required/)
  })
})

describe('plain words for lists and the assistant', () => {
  it('suffix: PPR, PPR in some cases, or nothing (no asterisk in text)', () => {
    expect(pprSuffix('always')).toBe(', PPR')
    expect(pprSuffix('conditional', ' · ')).toBe(' · PPR in some cases')
    expect(pprSuffix('none')).toBe('')
    expect(pprSuffix(undefined)).toBe('')
  })
  it('sentence: every state says something, unknown is not none', () => {
    expect(pprSentence('unknown')).toMatch(/no information/)
    expect(pprSentence('none')).toBe('No PPR required.')
    expect(pprSentence('conditional')).toMatch(/some cases/)
    expect(pprSentence('always')).toBe('PPR required.')
    expect(pprSentence(undefined)).toMatch(/no information/)
  })
  it('badge and explanation accept missing data', () => {
    expect(pprBadge(undefined)).toBeNull()
    expect(pprExplain(undefined)).toMatch(/no information/)
  })
})
