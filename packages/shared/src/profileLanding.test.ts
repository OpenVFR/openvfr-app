import { describe, it, expect } from 'vitest'
import { plannedAltitudeLine, projectFlightPath, profileLandingsNm, DEFAULT_PERF_MODEL, buildVirtualRadarProfile, EMPTY_FEATURES } from './virtualRadarCalc'
import { belowMsaRuns } from './profileChart'

describe('fuel stop landing in the planned path', () => {
  const wps = [
    { lat: 59, lng: 15, name: 'A' },
    { lat: 59.5, lng: 15, name: 'S', fuelStop: true, elevationFt: 300 },
    { lat: 60, lng: 15, name: 'B' },
  ]
  const prof = buildVirtualRadarProfile(wps, [{ altFt: 4500 }, { altFt: 4500 }], EMPTY_FEATURES, EMPTY_FEATURES, undefined, undefined, Infinity, 4500)
  const stopNm = prof.altitudeProfile[1].distNm

  it('marks the landing on the step profile', () => {
    expect(profileLandingsNm(prof.altitudeProfile)).toEqual([stopNm])
    expect(prof.altitudeProfile[1].groundFt).toBe(300)
  })
  it('descends to the field and climbs out again', () => {
    const line = plannedAltitudeLine(prof.altitudeProfile, prof.totalNm, DEFAULT_PERF_MODEL)
    const atStop = line.filter(v => Math.abs(v.distNm - stopNm) < 0.01)
    expect(atStop.some(v => v.altFt === 300)).toBe(true)
    const [mid] = projectFlightPath(prof.altitudeProfile, prof.totalNm, DEFAULT_PERF_MODEL, [stopNm])
    expect(mid).toBe(300)
    expect(Math.max(...line.map(v => v.altFt))).toBe(4500)
    expect(line[line.length - 1].distNm).toBeCloseTo(prof.totalNm, 1)
  })
  it('without the flag the path stays up', () => {
    const plain = buildVirtualRadarProfile(wps.map(({ fuelStop: _f, ...w }) => w), [{ altFt: 4500 }, { altFt: 4500 }], EMPTY_FEATURES, EMPTY_FEATURES, undefined, undefined, Infinity, 4500)
    expect(projectFlightPath(plain.altitudeProfile, plain.totalNm, DEFAULT_PERF_MODEL, [stopNm])[0]).toBe(4500)
  })
  it('does not shade the descent into a stop as below MSA', () => {
    const d = [stopNm - 2, stopNm, stopNm + 2]
    const runs = belowMsaRuns({ distNms: d, plannedAlts: [1000, 300, 1000], getMsa: () => 2500, totalNm: prof.totalNm, landingsNm: [stopNm] })
    expect(runs).toEqual([])
  })
})
