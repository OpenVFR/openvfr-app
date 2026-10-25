import { describe, it, expect } from 'vitest'
import type { FeatureCollection } from 'geojson'
import { buildObstructionPoints, obstructionTipFt } from './obstructionPoints'

const fc = (props: Record<string, unknown>[]): FeatureCollection => ({
  type: 'FeatureCollection',
  features: props.map((p, i) => ({ type: 'Feature', properties: p, geometry: { type: 'Point', coordinates: [17 + i * 0.1, 60] } })),
})

describe('buildObstructionPoints', () => {
  it('uses a recorded height as is', () => {
    const [p] = buildObstructionPoints(fc([{ kind: 'tower', elevation_ft: 100, height_m: 100 }]), null, [])
    expect(p.tipFt).toBe(100 + 328)
    expect(p.estimated).toBe(false)
  })
  it('estimates a missing height instead of treating the tip as ground', () => {
    const [p] = buildObstructionPoints(fc([{ kind: 'wind_turbine', elevation_ft: 100 }]), null, [])
    expect(p.tipFt).toBe(100 + Math.round(135 * 3.28084))
    expect(p.estimated).toBe(true)
  })
  it('keeps landmarks without a ground grid, relative to the aircraft ground', () => {
    const [p] = buildObstructionPoints(null, fc([{ kind: 'mast', height_m: 50 }]), [])
    expect(p.groundKnown).toBe(false)
    expect(obstructionTipFt(p, 200)).toBe(200 + 164)
    expect(obstructionTipFt(p, null)).toBeNull()
  })
  it('gives unique keys even for equal names', () => {
    const pts = buildObstructionPoints(fc([{ kind: 'tower', name: 'A', elevation_ft: 1, height_m: 5 }, { kind: 'tower', name: 'A', elevation_ft: 1, height_m: 5 }]), null, [])
    expect(new Set(pts.map((x) => x.key)).size).toBe(2)
  })
})

import { groupObstructionAlerts } from './obstructionPoints'
describe('groupObstructionAlerts', () => {
  const a = (key: string, kind: string, distNm: number, tipFt: number) => ({ key, kind, name: key, elevationFt: 100, tipFt, estimated: true, distNm })
  it('merges same-kind alerts: nearest distance, highest tip, count', () => {
    const g = groupObstructionAlerts([a('a', 'mast', 0.9, 500), a('b', 'mast', 0.4, 700), a('c', 'chimney', 0.6, 300)])
    expect(g).toHaveLength(2)
    expect(g[0]).toMatchObject({ key: 'kind:mast', distNm: 0.4, tipFt: 700, count: 2 })
    expect(g[1]).toMatchObject({ key: 'kind:chimney', count: 1 })
  })
})

import { obstructionThreatDistNm, summarizeObstructionAlerts } from './obstructionPoints'

describe('obstructionThreatDistNm', () => {
  const own = { lat: 60, lng: 17, trackDeg: 0, speedKts: 90 }
  const nm = (n: number) => n / 60
  it('flags an obstacle straight ahead', () => {
    expect(obstructionThreatDistNm(own, { lat: 60 + nm(2), lng: 17 })).toBeCloseTo(2, 1)
  })
  it('ignores one beside the track', () => {
    expect(obstructionThreatDistNm(own, { lat: 60 + nm(1), lng: 17 + nm(0.9) / 0.5 })).toBeNull()
  })
  it('ignores one behind', () => {
    expect(obstructionThreatDistNm(own, { lat: 60 - nm(0.6), lng: 17 })).toBeNull()
  })
  it('ignores one beyond the reach', () => {
    expect(obstructionThreatDistNm(own, { lat: 60 + nm(4), lng: 17 })).toBeNull()
  })
  it('stays silent when (nearly) stationary', () => {
    expect(obstructionThreatDistNm({ ...own, speedKts: 0 }, { lat: 60 + nm(0.1), lng: 17 })).toBeNull()
  })
  it('flags something very close whatever the heading', () => {
    expect(obstructionThreatDistNm(own, { lat: 60 - nm(0.2), lng: 17 })).not.toBeNull()
  })
})

describe('summarizeObstructionAlerts', () => {
  const a = (kind: string, count: number, distNm: number, tipFt: number, estimated = false) =>
    ({ key: `kind:${kind}`, kind, name: kind, elevationFt: 0, tipFt, estimated, distNm, count })
  it('merges kinds into one summary', () => {
    const s = summarizeObstructionAlerts([a('church', 4, 0.3, 382, true), a('mast', 5, 0.5, 699, true)])
    expect(s).toMatchObject({ count: 9, nearestNm: 0.3, highestTipFt: 699, estimated: true, keys: ['kind:church', 'kind:mast'] })
    expect(s?.kinds[0]).toEqual(['mast', 5])
  })
  it('is null for no alerts', () => expect(summarizeObstructionAlerts([])).toBeNull())
})

import { obstructionSummaryText } from './obstructionPoints'
describe('obstructionSummaryText', () => {
  const a = (kind: string, count: number, distNm: number, tipFt: number, estimated = false) =>
    ({ key: `kind:${kind}`, kind, name: kind, elevationFt: 0, tipFt, estimated, distNm, count })
  it('lists kinds with counts', () => {
    const s = summarizeObstructionAlerts([a('church', 4, 0.3, 382, true), a('mast', 5, 0.5, 699, true)])!
    expect(obstructionSummaryText(s)).toEqual({ title: '5 \u00d7 masts \u00b7 4 \u00d7 churches', meta: 'Highest top 699 ft (est.) \u00b7 nearest 0.3 NM ahead \u00b7 climb above 1200 ft' })
  })
  it('uses the name for a single obstacle', () => {
    const s = summarizeObstructionAlerts([a('windmill', 1, 0.5, 166)])!
    expect(obstructionSummaryText(s, 'Kvarnen')).toEqual({ title: 'Kvarnen', meta: 'Top 166 ft \u00b7 nearest 0.5 NM ahead \u00b7 climb above 700 ft' })
  })
})

import { obstructionRiskAltFt, obstructionClearFt } from './obstructionPoints'
describe('obstructionRiskAltFt', () => {
  it('tests a level or climbing aircraft at its current altitude', () => {
    expect(obstructionRiskAltFt(1500, 0, 2, 90)).toBe(1500)
    expect(obstructionRiskAltFt(1500, 800, 2, 90)).toBe(1500)
    expect(obstructionRiskAltFt(1500, -100, 2, 90)).toBe(1500)
  })
  it('projects a descent to the arrival at the obstacle', () => {
    // 2 NM at 120 kt = 1 min; -600 fpm -> 600 ft lower
    expect(obstructionRiskAltFt(1500, -600, 2, 120)).toBe(900)
  })
  it('caps the credited descent', () => {
    expect(obstructionRiskAltFt(5000, -2000, 5, 60)).toBe(3500)
  })
})
describe('obstructionClearFt', () => {
  it('adds the margin and rounds up to 100 ft', () => {
    expect(obstructionClearFt(699)).toBe(1200)
    expect(obstructionClearFt(700)).toBe(1200)
    expect(obstructionClearFt(701)).toBe(1300)
  })
})
