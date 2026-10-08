import { describe, it, expect } from 'vitest'
import { initialAutoFlyState, stepAutoFly, autoFlyThresholds, type AutoFlyState, type AutoFlyThresholds } from './autoFlyDetect'

function run(speeds: number[], flying: boolean, st = initialAutoFlyState(), t0 = 0, dt = 1000, acc = 10, thr?: AutoFlyThresholds) {
  const events: (string | null)[] = []
  let state: AutoFlyState = st
  speeds.forEach((s, i) => {
    const r = stepAutoFly(state, { speedKts: s, accuracyM: acc, t: t0 + i * dt }, flying, thr)
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
