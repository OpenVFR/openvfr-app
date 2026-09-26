import { describe, it, expect } from 'vitest'
import { emptyHistory, recordChange, undo, redo } from './undoHistory'

describe('undoHistory', () => {
  it('undo then redo round-trips', () => {
    let h = emptyHistory<number>()
    h = recordChange(h, 0, 1000)      // 0 -> 1
    h = recordChange(h, 1, 2000)      // 1 -> 2
    const u = undo(h, 2)!
    expect(u.state).toBe(1)
    const u2 = undo(u.history, 1)!
    expect(u2.state).toBe(0)
    expect(undo(u2.history, 0)).toBeNull()
    const r = redo(u2.history, 0)!
    expect(r.state).toBe(1)
    expect(redo(r.history, 1)!.state).toBe(2)
  })
  it('coalesces rapid updates into one step (keeps the earliest snapshot)', () => {
    let h = emptyHistory<string>()
    h = recordChange(h, 'a', 1000)
    h = recordChange(h, 'b', 1100)    // same action
    expect(h.past).toEqual(['a'])
    expect(undo(h, 'c')!.state).toBe('a')
  })
  it('a new change clears redo', () => {
    let h = emptyHistory<number>()
    h = recordChange(h, 0, 1000)
    h = undo(h, 1)!.history
    expect(h.future).toEqual([1])
    h = recordChange(h, 0, 5000)
    expect(h.future).toEqual([])
  })
  it('does not coalesce right after an undo', () => {
    let h = emptyHistory<number>()
    h = recordChange(h, 0, 1000)
    h = recordChange(h, 1, 2000)
    h = undo(h, 2)!.history           // past [0], lastRecordAt reset
    h = recordChange(h, 1, 2010)
    expect(h.past).toEqual([0, 1])
  })
  it('caps length', () => {
    let h = emptyHistory<number>()
    for (let i = 0; i < 60; i++) h = recordChange(h, i, i * 1000, 400, 50)
    expect(h.past.length).toBe(50)
    expect(h.past[0]).toBe(10)
  })
})
