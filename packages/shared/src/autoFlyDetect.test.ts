import { describe, it, expect } from 'vitest'
import { initialAutoFlyState, stepAutoFly, autoFlyThresholds, type AutoFlyState, type AutoFlyThresholds } from './autoFlyDetect'

// Default: 1000 ft above 100 ft terrain, i.e. clearly in the air.
const AIR = { altFt: 1100, groundFt: 100 }

function run(
  speeds: number[], flying: boolean, st = initialAutoFlyState(), t0 = 0, dt = 1000, acc = 10, thr?: AutoFlyThresholds,
  alt: (i: number) => { altFt?: number | null; groundFt?: number | null } = () => AIR,
) {
  const events: (string | null)[] = []
  let state: AutoFlyState = st
  speeds.forEach((s, i) => {
    const r = stepAutoFly(state, { speedKts: s, accuracyM: acc, t: t0 + i * dt, ...alt(i) }, flying, thr)
    state = r.state
    if (r.event) events.push(r.event)
  })
  return { state, events }
}

describe('autoFlyDetect', () => {
  it('suggests start after 5 fast fixes, once', () => {
    const r = run(Array(20).fill(80), false)
    expect(r.events).toEqual(['suggest-start'])
  })
  it('needs consecutive fast fixes', () => {
    expect(run([80, 80, 80, 80, 10, 80, 80, 80, 80], false).events).toEqual([])
  })
  it('ignores inaccurate fixes', () => {
    expect(run(Array(20).fill(80), false, initialAutoFlyState(), 0, 1000, 500).events).toEqual([])
  })
  it('re-arms after slowing below landing speed', () => {
    const r = run([...Array(6).fill(80), 5, ...Array(6).fill(80)], false)
    expect(r.events).toEqual(['suggest-start', 'suggest-start'])
  })
  it('does not re-suggest after user stops mid-air', () => {
    let r = run(Array(3).fill(80), true)
    r = run(Array(10).fill(80), false, r.state, 10_000)
    expect(r.events).toEqual([])
  })
  it('suggests stop after landing once airborne long enough', () => {
    let r = run([60], true)
    r = run(Array(15).fill(5), true, r.state, 70_000)
    expect(r.events).toEqual(['suggest-stop'])
  })
  it('does not suggest stop during a short slow spell right after takeoff', () => {
    let r = run([60], true)
    r = run(Array(15).fill(5), true, r.state, 10_000)
    expect(r.events).toEqual([])
  })
  it('never suggests stop if never airborne', () => {
    expect(run(Array(100).fill(0), true, initialAutoFlyState(), 0, 5000).events).toEqual([])
  })
})

describe('autoFlyDetect: speed alone is not a flight', () => {
  it('a car on a road (on the terrain) never starts, however fast', () => {
    expect(run(Array(600).fill(70), false, initialAutoFlyState(), 0, 1000, 10, undefined,
      () => ({ altFt: 160, groundFt: 120 })).events).toEqual([])
  })
  it('a bridge / embankment below the highest ground around never starts', () => {
    // 150 ft above the river, but the hills around are higher.
    expect(run(Array(600).fill(70), false, initialAutoFlyState(), 0, 1000, 10, undefined,
      () => ({ altFt: 250, groundFt: 260 })).events).toEqual([])
  })
  it('starts once 200 ft above the highest ground around', () => {
    const at = (alt: number) => run(Array(10).fill(60), false, initialAutoFlyState(), 0, 1000, 10, undefined,
      () => ({ altFt: alt, groundFt: 100 })).events
    expect(at(290)).toEqual([])
    expect(at(300)).toEqual(['suggest-start'])
  })
  it('starts while climbing from the runway', () => {
    // Climbing 10 ft per fix from the runway at 100 ft.
    const r = run(Array(60).fill(60), false, initialAutoFlyState(), 0, 1000, 10, undefined,
      i => ({ altFt: 100 + i * 10, groundFt: 100 }))
    expect(r.events).toEqual(['suggest-start'])
  })
  it('without terrain: a 300 ft climb counts, a flat drive does not', () => {
    const noGround = (alt: (i: number) => number) => (i: number) => ({ altFt: alt(i), groundFt: null })
    expect(run(Array(600).fill(70), false, initialAutoFlyState(), 0, 1000, 10, undefined,
      noGround(i => 200 + (i % 20))).events).toEqual([])
    expect(run(Array(60).fill(60), false, initialAutoFlyState(), 0, 1000, 10, undefined,
      noGround(i => 200 + i * 10)).events).toEqual(['suggest-start'])
  })
  it('no altitude, no start', () => {
    expect(run(Array(60).fill(80), false, initialAutoFlyState(), 0, 1000, 10, undefined,
      () => ({ altFt: null })).events).toEqual([])
  })
})

describe('autoFlyThresholds', () => {
  it('30 kt default keeps the original 40/30/20', () => {
    expect(autoFlyThresholds()).toEqual({ airborneKts: 40, takeoffKts: 30, landedKts: 20 })
    expect(autoFlyThresholds(0, 'SEP')).toEqual({ airborneKts: 40, takeoffKts: 30, landedKts: 20 })
  })
  it('profile takeoff speed wins over category', () => {
    expect(autoFlyThresholds(60, 'SEP')).toEqual({ airborneKts: 70, takeoffKts: 60, landedKts: 40 })
  })
  it('category default; landed never below 10 kt', () => {
    expect(autoFlyThresholds(undefined, 'GLIDER').takeoffKts).toBe(35)
    expect(autoFlyThresholds(10).landedKts).toBe(10)
  })
  it('a slow aircraft starts at its own speed', () => {
    const slow = autoFlyThresholds(20, 'GYRO') // start at 30
    expect(run(Array(10).fill(35), false).events).toEqual([])
    expect(run(Array(10).fill(35), false, initialAutoFlyState(), 0, 1000, 10, slow).events).toEqual(['suggest-start'])
  })
  it('a fast aircraft is not stopped by a slow-ish spell', () => {
    const fast = autoFlyThresholds(60) // landed < 40
    let r = run([90], true, initialAutoFlyState(), 0, 1000, 10, fast)
    r = run(Array(15).fill(30), true, r.state, 70_000, 1000, 10, fast)
    expect(r.events).toEqual(['suggest-stop'])
    r = run([90], true, initialAutoFlyState(), 0, 1000, 10, fast)
    r = run(Array(15).fill(50), true, r.state, 70_000, 1000, 10, fast)
    expect(r.events).toEqual([])
  })
})
