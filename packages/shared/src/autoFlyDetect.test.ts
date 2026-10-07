import { describe, it, expect } from 'vitest'
import { initialAutoFlyState, stepAutoFly, type AutoFlyState } from './autoFlyDetect'

function run(speeds: number[], flying: boolean, st = initialAutoFlyState(), t0 = 0, dt = 1000, acc = 10) {
  const events: (string | null)[] = []
  let state: AutoFlyState = st
  speeds.forEach((s, i) => {
    const r = stepAutoFly(state, { speedKts: s, accuracyM: acc, t: t0 + i * dt }, flying)
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
