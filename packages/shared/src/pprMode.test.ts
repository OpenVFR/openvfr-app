import { describe, it, expect } from 'vitest'
import { pprBadge, pprExplain, pprModeOf } from './pprMode'

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
