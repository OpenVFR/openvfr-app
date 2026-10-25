import { describe, it, expect } from 'vitest'
import { stabilize, type StableEntry } from './alertStability'
import { filterDismissed } from './alertDismiss'

type I = { key: string; enterMs?: number; minShowMs?: number; lingerMs?: number }
const run = (steps: Array<[number, I[]]>) => {
  let entries = new Map<string, StableEntry<I>>()
  return steps.map(([t, items]) => {
    const r = stabilize(entries, items, t)
    entries = r.entries
    return r.visible.map(i => i.key)
  })
}

describe('stabilize', () => {
  it('delays a new item until its condition held for enterMs', () => {
    expect(run([[0, [{ key: 'a' }]], [1000, [{ key: 'a' }]], [2000, [{ key: 'a' }]]]))
      .toEqual([[], [], ['a']])
  })
  it('shows instant items at once', () => {
    expect(run([[0, [{ key: 'a', enterMs: 0 }]]])).toEqual([['a']])
  })
  it('drops a pending item that disappears before it was shown (no flicker)', () => {
    expect(run([[0, [{ key: 'a' }]], [500, []], [3000, [{ key: 'a' }]]])).toEqual([[], [], []])
  })
  it('keeps a shown item for minShowMs and lingerMs after it ended', () => {
    const a = { key: 'a', enterMs: 0 }
    expect(run([[0, [a]], [1000, []], [4000, []], [5000, []], [5001, []]]))
      .toEqual([['a'], ['a'], ['a'], [], []])
  })
  it('keeps order of first appearance', () => {
    const r = run([[0, [{ key: 'b', enterMs: 0 }]], [10, [{ key: 'a', enterMs: 0 }, { key: 'b', enterMs: 0 }]]])
    expect(r[1]).toEqual(['b', 'a'])
  })
})

describe('filterDismissed', () => {
  it('mutes a dismissed hazard for as long as it is detected', () => {
    const d = new Map([['x', 0]])
    const f = [{ key: 'x' }, { key: 'y' }]
    expect(filterDismissed(d, f, 10 * 60_000).map(i => i.key)).toEqual(['y'])
    expect(filterDismissed(d, f, 20 * 60_000).map(i => i.key)).toEqual(['y'])
  })
  it('re-arms once the hazard has been gone long enough', () => {
    const d = new Map([['x', 0]])
    expect(filterDismissed(d, [], 30_000)).toEqual([])
    expect(d.has('x')).toBe(true)
    filterDismissed(d, [], 61_000)
    expect(d.has('x')).toBe(false)
    expect(filterDismissed(d, [{ key: 'x' }], 62_000).map(i => i.key)).toEqual(['x'])
  })
})
