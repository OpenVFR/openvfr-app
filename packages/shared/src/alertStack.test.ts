import { describe, it, expect } from 'vitest'
import { layoutAlertStack, type AlertSeverity, type AlertTier } from './alertStack'

const i = (key: string, severity: AlertSeverity, tier: AlertTier) => ({ key, severity, tier })
const keys = (a: { key: string }[]) => a.map(x => x.key)

describe('layoutAlertStack', () => {
  it('limits full cards to two, never hiding a red one', () => {
    const r = layoutAlertStack([i('y1', 'yellow', 'alert'), i('r1', 'red', 'alert'), i('r2', 'red', 'alert'), i('r3', 'red', 'alert')])
    expect(keys(r.cards)).toEqual(['r1', 'r2', 'r3'])
    expect(keys(r.chips)).toEqual(['y1'])
  })
  it('gives yellow alerts the slots before notes', () => {
    const r = layoutAlertStack([i('n', 'yellow', 'note'), i('a', 'yellow', 'alert'), i('b', 'yellow', 'alert')])
    expect(keys(r.cards)).toEqual(['a', 'b'])
    expect(keys(r.chips)).toEqual(['n'])
  })
  it('turns events and blue advisories into chips', () => {
    const r = layoutAlertStack([i('e', 'red', 'event'), i('b', 'blue', 'alert'), i('y', 'yellow', 'alert')])
    expect(keys(r.cards)).toEqual(['y'])
    expect(keys(r.chips)).toEqual(['e', 'b'])
  })
  it('counts chips beyond the limit as overflow', () => {
    const r = layoutAlertStack(Array.from({ length: 7 }, (_, n) => i(`e${n}`, 'blue', 'event')))
    expect(r.cards).toEqual([])
    expect(r.chips).toHaveLength(4)
    expect(r.overflow).toBe(3)
  })
})
