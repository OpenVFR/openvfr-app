import { describe, it, expect } from 'vitest'
import { chooseSnapTarget, sortSnapCandidates, snapHintText, neighbourAtDrop } from './snapChoice'

const at = { lat: 59.0, lng: 18.0 }
const near = { lat: 59.0001, lng: 18.0001 }
const far  = { lat: 59.001,  lng: 18.001 }

describe('chooseSnapTarget', () => {
  it('returns -1 with no candidates', () => {
    expect(chooseSnapTarget([], at)).toBe(-1)
  })
  it('picks the nearest feature', () => {
    const c = [{ kind: 'RP', waypoint: far }, { kind: 'VOR', waypoint: near }]
    expect(chooseSnapTarget(c, at)).toBe(1)
  })
  it('prefers an aerodrome over a nearer non-aerodrome', () => {
    const c = [{ kind: 'RP', waypoint: near }, { kind: 'AD', waypoint: far }]
    expect(chooseSnapTarget(c, at)).toBe(1)
  })
  it('picks the nearest of several aerodromes', () => {
    const c = [{ kind: 'AD', waypoint: far }, { kind: 'AD', waypoint: near }]
    expect(chooseSnapTarget(c, at)).toBe(1)
  })
  it('never snaps to the custom-point entry', () => {
    const c = [{ kind: 'PT', waypoint: at }, { kind: 'RP', waypoint: far }]
    expect(chooseSnapTarget(c, at)).toBe(1)
    expect(chooseSnapTarget([{ kind: 'PT', waypoint: at }], at)).toBe(-1)
  })
})

describe('sortSnapCandidates', () => {
  it('orders aerodromes first, then by distance, custom point last', () => {
    const c = [
      { kind: 'PT',  waypoint: at },
      { kind: 'RP',  waypoint: far },
      { kind: 'VOR', waypoint: near },
      { kind: 'AD',  waypoint: far },
    ]
    expect(sortSnapCandidates(c, at).map((x) => x.kind)).toEqual(['AD', 'VOR', 'RP', 'PT'])
  })
})

describe('snapHintText', () => {
  it('formats name, kind and extra count', () => {
    expect(snapHintText({ kind: 'AD', waypoint: { name: 'ESSB' } }, 0)).toBe('ESSB · AD')
    expect(snapHintText({ kind: 'AD', waypoint: { name: 'ESSB' } }, 2)).toBe('ESSB · AD (+2)')
    expect(snapHintText({ kind: 'OBS', waypoint: {} }, 0)).toBe('OBS')
  })
})

describe('neighbourAtDrop', () => {
  const wps = [{ lat: 59, lng: 18 }, { lat: 59.5, lng: 18.5 }, { lat: 60, lng: 19 }]
  it('finds the previous or next waypoint at the drop point', () => {
    expect(neighbourAtDrop(wps, 1, { lat: 59, lng: 18 })).toBe(0)
    expect(neighbourAtDrop(wps, 1, { lat: 60, lng: 19 })).toBe(2)
  })
  it('treats a position a few metres off (tile quantisation) as the neighbour', () => {
    expect(neighbourAtDrop(wps, 1, { lat: 59 + 0.00018, lng: 18 })).toBe(0)   // ~20 m
    expect(neighbourAtDrop(wps, 1, { lat: 59 + 0.001, lng: 18 })).toBe(-1)    // ~110 m
  })
  it('ignores non-neighbours and free points', () => {
    expect(neighbourAtDrop(wps, 0, { lat: 60, lng: 19 })).toBe(-1)
    expect(neighbourAtDrop(wps, 1, { lat: 59.2, lng: 18.2 })).toBe(-1)
  })
})
