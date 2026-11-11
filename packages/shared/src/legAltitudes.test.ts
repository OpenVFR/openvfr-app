import { describe, it, expect } from 'vitest'
import { legAltitudes, isSemicircularLevel, lowestLevelAtOrAbove } from './legAltitudes'
import type { AirspaceCrossSection } from './virtualRadarCalc'

// East-bound leg of ~30 NM.
const wps = [{ lat: 59.0, lng: 15.0, name: 'AAAA' }, { lat: 59.0, lng: 15.97, name: 'BBBB' }]
const span = { legIndex: 0, fromNm: 0, toNm: 30, altFt: 2500 }
const band = (o: Partial<AirspaceCrossSection>): AirspaceCrossSection => ({
  class: 'C', type: 'TMA', name: 'TEST TMA', lower_ft: 2500, upper_ft: 9500, entryNm: 10, exitNm: 30, fill: '', border: '', tag: 'C', freq: '123.450', ...o,
})
const flat = [{ distNm: 0, elevFt: 200 }, { distNm: 15, elevFt: 300 }, { distNm: 30, elevFt: 250 }]

describe('semicircular levels', () => {
  it('odd + 500 east, even + 500 west', () => {
    expect(isSemicircularLevel(3500, 90)).toBe(true)
    expect(isSemicircularLevel(4500, 90)).toBe(false)
    expect(isSemicircularLevel(4500, 270)).toBe(true)
    expect(lowestLevelAtOrAbove(3600, 90, 0)).toBe(5500)
    expect(lowestLevelAtOrAbove(2100, 90, 0)).toBe(2500)
  })
})

describe('legAltitudes', () => {
  it('suggests a level below the TMA when terrain allows', () => {
    const [l] = legAltitudes({ waypoints: wps, spans: [span], bands: [band({})], legMsaFt: [1300], msaApplies: [true], terrain: flat })
    expect(l!.controlledFloorFt).toBe(2500)
    expect(l!.advice).toMatchObject({ kind: 'ok', suggestedFt: 1500 })
    expect(l!.planned.join()).toMatch(/inside TEST TMA .* NM 10-30 of the leg: needs a clearance/)
  })
  it('reports a conflict when the MSA reaches the floor, never a level below the MSA', () => {
    const [l] = legAltitudes({ waypoints: wps, spans: [{ ...span, altFt: 2000 }], bands: [band({ lower_ft: 2000 })], legMsaFt: [2300], msaApplies: [true], terrain: flat })
    expect(l!.advice.kind).toBe('conflict')
    expect(l!.advice).toMatchObject({ suggestedFt: 2500 })
    expect(l!.advice.text).toMatch(/123\.450/)
    expect(l!.advice.text).toMatch(/route around it: it covers NM 10-30/)
    expect(l!.planned.join()).toMatch(/below the MSA of 2,300 ft/)
  })
  it('suggests changing level when parts of the leg have different limits', () => {
    const msaPts = [{ distNm: 0, msaFt: 2300 }, { distNm: 5, msaFt: 2300 }, { distNm: 10, msaFt: 1300 }, { distNm: 20, msaFt: 1300 }, { distNm: 30, msaFt: 1300 }]
    const [l] = legAltitudes({ waypoints: wps, spans: [span], bands: [band({ lower_ft: 2000 })], legMsaFt: [2300], msaApplies: [true], msaPts, terrain: flat })
    expect(l!.advice.kind).toBe('split')
    expect(l!.advice.text).toMatch(/2,500 ft on NM 0-10 of the leg, then 1,500 ft on NM 10-30 of the leg \(below TEST TMA from 2,000 ft\)/)
  })
  it('treats a control zone from the surface as a clearance at any altitude, not as a floor', () => {
    const ctr = band({ type: 'CTR', name: 'TEST CTR', lower_ft: 0, upper_ft: 2000, entryNm: 12, exitNm: 18 })
    const [l] = legAltitudes({ waypoints: wps, spans: [span], bands: [ctr], legMsaFt: [1300], msaApplies: [true], terrain: flat })
    expect(l!.controlledFloorFt).toBeNull()
    expect(l!.advice).toMatchObject({ kind: 'ok', suggestedFt: 1500 })
    expect(l!.notes[0]).toMatch(/Crosses TEST CTR .* NM 12-18 .* any altitude below 2,000 ft, or fly above it/)
  })
  it('says so without terrain', () => {
    const [l] = legAltitudes({ waypoints: wps, spans: [span], bands: [], legMsaFt: [0], msaApplies: [true], terrain: [] })
    expect(l!.advice.kind).toBe('unknown')
  })
  it('flags a level that is not a VFR cruising level high above the ground', () => {
    const [l] = legAltitudes({ waypoints: wps, spans: [{ ...span, altFt: 4500 }], bands: [], legMsaFt: [1300], msaApplies: [true], terrain: flat })
    expect(l!.planned.join()).toMatch(/not a VFR cruising level for magnetic track/)
  })
})
