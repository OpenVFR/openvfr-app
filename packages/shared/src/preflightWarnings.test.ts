import { describe, it, expect } from 'vitest'
import { computeWarnings, isEndpointSurfaceAirspace } from './preflightWarnings'
import type { VirtualRadarProfile } from './virtualRadarCalc'

function profile(over: Partial<VirtualRadarProfile> = {}): VirtualRadarProfile {
  return {
    totalNm: 50,
    altitudeProfile: [{ distNm: 0, altFt: 3000 }],
    maxPlannedAltFt: 3000,
    airspaceBands: [],
    obstacles: [],
    landmarks: [],
    waterCrossings: [],
    waypointTicks: [],
    ...over,
  } as VirtualRadarProfile
}

const codes = (w: { code: string }[]) => w.map((x) => x.code)

describe('computeWarnings', () => {
  it('is empty for a clean route', () => {
    expect(computeWarnings(profile(), [], undefined, [], [])).toEqual([])
  })

  it('flags Class D penetration at planned altitude', () => {
    const band = { class: 'D', type: 'CTR', name: 'Test CTR', lower_ft: 0, upper_ft: 4000, entryNm: 10, exitNm: 20 }
    const w = computeWarnings(profile({ airspaceBands: [band] as never }), [], undefined, [], [])
    expect(codes(w)).toEqual(['airspace-penetration'])
    expect(w[0].level).toBe('warn')
  })

  it('does not flag airspace above the planned altitude', () => {
    const band = { class: 'D', type: 'CTA', name: 'High', lower_ft: 5000, upper_ft: 9000, entryNm: 10, exitNm: 20 }
    expect(computeWarnings(profile({ airspaceBands: [band] as never }), [], undefined, [], [])).toEqual([])
  })

  it('flags restricted areas as danger', () => {
    const band = { class: 'R', type: 'R', name: 'EDR1', lower_ft: 0, upper_ft: 4000, entryNm: 10, exitNm: 20 }
    expect(computeWarnings(profile({ airspaceBands: [band] as never }), [], undefined, [], [])[0].level).toBe('danger')
  })

  describe('below MSA, per leg', () => {
    const wps = [
      { lat: 59, lng: 18, name: 'ESSA' }, { lat: 59.5, lng: 18, name: 'ALPHA' },
      { lat: 60, lng: 18, name: 'BRAVO' }, { lat: 60.5, lng: 18, name: 'ESOW' },
    ]
    // three 20 NM legs, 3000 ft planned
    const legs = profile({
      totalNm: 60,
      altitudeProfile: [
        { distNm: 0, altFt: 3000 }, { distNm: 20, altFt: 3000 },
        { distNm: 20, altFt: 3000 }, { distNm: 40, altFt: 3000 },
        { distNm: 40, altFt: 3000 }, { distNm: 60, altFt: 3000 },
      ] as never,
    })
    const msa = (m: number[]) => [10, 30, 50].map((d, i) => ({ distNm: d, msaFt: m[i] }))

    it('names only the leg that is too low and offers a raise', () => {
      const w = computeWarnings(legs, msa([0, 3450, 0]), undefined, wps, [])
      expect(codes(w)).toEqual(['below-msa'])
      expect(w[0].title).toContain('ALPHA → BRAVO')
      expect(w[0].detail).toContain('3,500 ft')
      expect(w[0].fix).toEqual({ kind: 'raise-leg', legIndex: 1, altFt: 3500 })
    })
    it('gives one warning per low leg', () => {
      expect(codes(computeWarnings(legs, msa([3600, 3600, 0]), undefined, wps, []))).toEqual(['below-msa', 'below-msa'])
    })
    it('does not flag a leg at or above MSA', () => {
      expect(computeWarnings(legs, msa([3000, 2000, 0]), undefined, wps, [])).toEqual([])
    })
    it('ignores a short leg wholly inside the 5 NM window', () => {
      const short = profile({
        totalNm: 4,
        altitudeProfile: [{ distNm: 0, altFt: 500 }, { distNm: 4, altFt: 500 }] as never,
      })
      expect(computeWarnings(short, [{ distNm: 0, msaFt: 2000 }], undefined, wps, [])).toEqual([])
    })
  })

  it('warns when the route aircraft is missing', () => {
    expect(codes(computeWarnings(profile(), [], undefined, [], [], 'gone'))).toEqual(['aircraft-profile-missing'])
  })

  it('warns when terrain is unavailable', () => {
    expect(codes(computeWarnings(profile(), [], undefined, [], [], undefined, true))).toEqual(['terrain-unavailable'])
  })
})

describe('airspace at the departure / arrival aerodrome', () => {
  const ctr = (over: object) => ({ class: 'D', type: 'CTR', name: 'Home CTR', lower_ft: 0, upper_ft: 4000, entryNm: 0, exitNm: 6, ...over })
  const run = (band: object, totalNm = 50) =>
    computeWarnings(profile({ totalNm, airspaceBands: [band] as never }), [], undefined, [], [])

  it('skips a surface-level CTR the route starts in', () => {
    expect(run(ctr({ openStart: true, lowerAgl: true }))).toEqual([])
  })
  it('skips a surface-level CTR the route ends in', () => {
    expect(run(ctr({ entryNm: 44, exitNm: 50, openEnd: true, lowerAgl: true }))).toEqual([])
  })
  it('still warns for a TMA above the departure aerodrome', () => {
    expect(codes(run(ctr({ type: 'TMA', name: 'Big TMA', lower_ft: 2500, upper_ft: 4000, openStart: true, lowerAgl: true })))).toEqual(['airspace-penetration'])
  })
  it('still warns for a CTR crossed en route', () => {
    expect(codes(run(ctr({ entryNm: 20, exitNm: 30 })))).toEqual(['airspace-penetration'])
  })
  it('uses terrain: an AGL floor lifted to ground counts as surface', () => {
    const pts = [{ distNm: 0, elevFt: 800 }, { distNm: 50, elevFt: 800 }] as never
    expect(isEndpointSurfaceAirspace(ctr({ openStart: true, lowerAgl: true, lower_ft: 800 }) as never, 50, pts)).toBe(true)
    expect(isEndpointSurfaceAirspace(ctr({ openStart: true, lowerAgl: true, lower_ft: 2300 }) as never, 50, pts)).toBe(false)
  })
})

describe('airspace categories and levels', () => {
  const band = (over: object) => ({ class: 'D', type: 'CTA', name: 'X', lower_ft: 0, upper_ft: 4000, entryNm: 10, exitNm: 20, ...over })
  const run = (b: object, levels?: never) =>
    computeWarnings(profile({ airspaceBands: [b] as never }), [], undefined, [], [], undefined, false, undefined, undefined, [], levels)

  it('warns for class A as danger', () => {
    const w = run(band({ class: 'A' }))
    expect(w[0].level).toBe('danger')
  })
  it('warns for class B as a warning', () => {
    expect(run(band({ class: 'B' }))[0].level).toBe('warn')
  })
  it('skips class E by default, shows it when set to alert', () => {
    expect(run(band({ class: 'E' }))).toEqual([])
    expect(run(band({ class: 'E' }), { restricted: 'alert', classA: 'alert', controlled: 'alert', classEF: 'alert', zones: 'info', activity: 'info' } as never)[0].level).toBe('warn')
  })
  it('shows zones as info by default', () => {
    const w = run(band({ class: 'G', type: 'RMZ', name: 'Local RMZ' }))
    expect(w.map((x) => x.level)).toEqual(['info'])
    expect(w[0].title).toContain('RMZ')
  })
  it('ignores plain class G / FIR', () => {
    expect(run(band({ class: 'G', type: 'FIR' }))).toEqual([])
  })
  it('honours ignore for controlled airspace', () => {
    expect(run(band({ class: 'D' }), { restricted: 'alert', classA: 'alert', controlled: 'ignore', classEF: 'ignore', zones: 'info', activity: 'info' } as never)).toEqual([])
  })
})
