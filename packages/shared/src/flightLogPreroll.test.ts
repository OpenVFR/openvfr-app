import { describe, it, expect } from 'vitest'
import { takeoffRun, trimPreroll, PREROLL_KEEP_MS } from './flightLogPreroll'

const fx = (spdKts: number, ts: number) => ({ lat: 59, lng: 18, altFt: 100, spdKts, trkDeg: 90, ts })

describe('takeoffRun', () => {
  it('goes back to where the roll began (one fix before it)', () => {
    const fixes = [fx(0, 0), fx(5, 1000), fx(8, 2000), fx(25, 3000), fx(45, 4000), fx(60, 5000)]
    expect(takeoffRun(fixes, 20).map(f => f.ts)).toEqual([2000, 3000, 4000, 5000])
  })
  it('a gap ends the run', () => {
    const fixes = [fx(50, 0), fx(50, 1000), fx(50, 30_000), fx(55, 31_000)]
    expect(takeoffRun(fixes, 20).map(f => f.ts)).toEqual([30_000, 31_000])
  })
  it('nothing when the newest fix is slow', () => {
    expect(takeoffRun([fx(50, 0), fx(5, 1000)], 20)).toEqual([])
    expect(takeoffRun([], 20)).toEqual([])
  })
})

describe('trimPreroll', () => {
  it('keeps the last PREROLL_KEEP_MS', () => {
    const fixes = [fx(0, 0), fx(0, 1000), fx(0, PREROLL_KEEP_MS + 500)]
    expect(trimPreroll(fixes, PREROLL_KEEP_MS + 500).map(f => f.ts)).toEqual([1000, PREROLL_KEEP_MS + 500])
  })
})
