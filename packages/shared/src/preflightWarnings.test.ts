import { describe, it, expect } from 'vitest'
import { computeWarnings, isEndpointSurfaceAirspace, airfieldProximity } from './preflightWarnings'
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

  it('warns about a route an assistant made until the pilot saves it', () => {
    const w = computeWarnings(profile(), [], undefined, [], [], undefined, false, undefined, undefined, { routeReview: { by: 'Claude', at: 1, change: 'created' } })
    expect(codes(w)).toEqual(['route-assistant-review'])
    expect(w[0]!.detail).toMatch(/Made by Claude/)
    expect(computeWarnings(profile(), [], undefined, [], [], undefined, false, undefined, undefined, { routeReview: null })).toEqual([])
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
    computeWarnings(profile({ airspaceBands: [b] as never }), [], undefined, [], [], undefined, false, undefined, undefined, levels ? { airspaceLevels: levels } : {})

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

describe('airfield proximity', () => {
  // Route runs due north along lng 18 from lat 59 to 60 (60 NM).
  const wps = [{ lat: 59, lng: 18, name: 'ESSA' }, { lat: 60, lng: 18, name: 'ESOW' }]
  const field = (icao: string, lat: number, lng: number, elevation_ft: number | undefined, type = 'AD') => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: { icao, name: icao, type, elevation_ft },
  })
  const fc = (...f: object[]) => ({ type: 'FeatureCollection', features: f }) as never
  const prof = (alt: number) => profile({
    totalNm: 60, altitudeProfile: [{ distNm: 0, altFt: alt }, { distNm: 60, altFt: alt }] as never,
  })
  const run = (alt: number, aero: never) =>
    computeWarnings(prof(alt), [], undefined, wps, [], undefined, false, undefined, undefined, { aerodromes: aero })

  it('flags a field within 1 NM of the track at low level', () => {
    const w = run(1500, fc(field('ESKX', 59.5, 18.01, 100)))
    expect(codes(w)).toEqual(['airfield-proximity'])
    expect(w[0].level).toBe('warn')
    expect(w[0].title).toContain('ESKX')
  })
  it('ignores a field more than 1 NM off the track', () => {
    expect(run(1500, fc(field('ESKX', 59.5, 18.1, 100)))).toEqual([])
  })
  it('ignores a pass higher than 1,500 ft above the field', () => {
    expect(run(2000, fc(field('ESKX', 59.5, 18.01, 100)))).toEqual([])
  })
  it('ignores the route\'s own ends, a named waypoint and heliports', () => {
    expect(run(500, fc(field('ESSA', 59.0, 18.0, 100), field('ESOW', 60.0, 18.0, 100)))).toEqual([])
    expect(run(1500, fc(field('ESKX', 59.5, 18.0, 100, 'HP')))).toEqual([])
    const via = [wps[0], { lat: 59.5, lng: 18, name: 'ESKX' }, wps[1]]
    expect(airfieldProximity(prof(1500), via, fc(field('ESKX', 59.5, 18.0, 100)))).toEqual([])
  })
  it('skips a field with no known height when there is no terrain', () => {
    expect(run(1500, fc(field('ESKX', 59.5, 18.01, undefined)))).toEqual([])
  })
  it('uses terrain when the field has no elevation', () => {
    const pts = [{ distNm: 0, elevFt: 100 }, { distNm: 60, elevFt: 100 }] as never
    expect(airfieldProximity(prof(1500), wps, fc(field('ESKX', 59.5, 18.01, undefined)), pts)).toHaveLength(1)
  })
  it('lists each field once', () => {
    expect(airfieldProximity(prof(1500), wps, fc(field('ESKX', 59.5, 18.01, 100), field('ESKX', 59.51, 18.01, 100)))).toHaveLength(1)
  })
})

describe('ordering and labels', () => {
  it('lists danger before warn before info', () => {
    const bands = [
      { class: 'G', type: 'RMZ', name: 'Z', lower_ft: 0, upper_ft: 4000, entryNm: 5, exitNm: 8 },
      { class: 'D', type: 'CTA', name: 'D1', lower_ft: 0, upper_ft: 4000, entryNm: 10, exitNm: 12 },
      { class: 'R', type: 'R', name: 'ESR1 TEST', lower_ft: 0, upper_ft: 4000, entryNm: 20, exitNm: 25 },
    ]
    const w = computeWarnings(profile({ airspaceBands: bands as never }), [], undefined, [], [])
    expect(w.map((x) => x.level)).toEqual(['danger', 'warn', 'info'])
    expect(w[0].title).toContain('Restricted / danger area')
  })
})

describe('restricted areas at the route ends, and missing data', () => {
  it('still warns for a surface restricted area the route starts in', () => {
    const band = { class: 'R', type: 'R', name: 'ESR9 TEST', lower_ft: 0, upper_ft: 4000, entryNm: 0, exitNm: 6, openStart: true, lowerAgl: true }
    const w = computeWarnings(profile({ airspaceBands: [band] as never }), [], undefined, [], [])
    expect(w.map((x) => x.code)).toEqual(['airspace-penetration'])
  })
  it('says which route data is missing, so no data is not read as all clear', () => {
    const w = computeWarnings(profile(), [], undefined, [], [], undefined, false, undefined, undefined,
      { unavailable: { airspace: true, obstacles: true, aerodromes: true, notams: 'Sign in' } })
    expect(w.map((x) => [x.code, x.level])).toEqual([
      ['route-data-unavailable', 'warn'], ['aerodromes-unavailable', 'info'], ['notams-unavailable', 'info'],
    ])
    expect(w[0].title).toContain('airspace and obstacles')
  })
})

describe('aircraft equipment and crosswind', () => {
  const ac = (over: Record<string, unknown>) => ({
    id: 'a', name: 'T', registration: 'X', icaoType: 'C172', category: 'SEP',
    cruiseAltFt: 3000, cruiseIas: 100, fuelBurnLhr: 0, maxFuelL: 0, taxiFuelL: 0, landingFuelL: 0,
    holdingMin: 0, contingencyPct: 0, serviceCeilingFt: 0, rocSlFpm: 0, rocCeilingFpm: 0, climbIas: 0,
    climbFuelLhr: 0, descentFpm: 0, descentIas: 0, descentFuelLhr: 0, bestGlideIas: 0, glideRatio: 0,
    updatedAt: 0, ...over,
  }) as never
  const tmz = { class: 'TMZ', type: 'TMZ', name: 'Test TMZ', lower_ft: 0, upper_ft: 4000, entryNm: 10, exitNm: 20 }
  const ctr = { class: 'D', type: 'CTR', name: 'Test CTR', lower_ft: 0, upper_ft: 4000, entryNm: 25, exitNm: 30 }

  it('turns a TMZ crossing into a danger without a transponder', () => {
    const w = computeWarnings(profile({ airspaceBands: [tmz] as never }), [], ac({ transponder: 'none' }), [], [])
    expect(codes(w)).toEqual(['airspace-equipment'])
    expect(w[0].level).toBe('danger')
  })
  it('keeps the normal reminder when the equipment is fitted or not set', () => {
    expect(codes(computeWarnings(profile({ airspaceBands: [tmz] as never }), [], ac({ transponder: 'S' }), [], []))).toEqual(['airspace-penetration'])
    expect(codes(computeWarnings(profile({ airspaceBands: [tmz] as never }), [], ac({}), [], []))).toEqual(['airspace-penetration'])
  })
  it('needs a radio in a control zone', () => {
    const w = computeWarnings(profile({ airspaceBands: [ctr] as never }), [], ac({ hasRadio: false }), [], [])
    expect(codes(w)).toEqual(['airspace-equipment'])
  })
  it('flags a runway too short for landing at the destination', () => {
    const aerodromes = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [18, 60] }, properties: {
      icao: 'ESXX', elevation_ft: 0, runways: [{ designator: '09/27', length_m: 450, surface: 'GRASS', thresholds: [] }],
    } }] } as never
    const wps = [{ lat: 59, lng: 18, name: 'ESAA' }, { lat: 60, lng: 18, name: 'ESXX' }]
    const w = computeWarnings(profile(), [], ac({ landingDist50ftM: 300 }), wps, [], undefined, false, undefined, undefined, { aerodromes })
    // 300 x 1.15 (grass) x 1.43 = 493 m > 450 m
    const rw = w.find(x => x.code === 'runway-short')
    expect(rw?.level).toBe('danger')
    expect(rw?.detail).toContain('493 m')
  })

  it('flags crosswind above the limit at the destination', () => {
    const aerodromes = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [18, 60] }, properties: {
      icao: 'ESXX', runways: [{ thresholds: [{ designator: '09', mag_brg: 90, true_brg: 90 }, { designator: '27', mag_brg: 270, true_brg: 270 }] }],
    } }] } as never
    const wps = [{ lat: 59, lng: 18, name: 'ESAA' }, { lat: 60, lng: 18, name: 'ESXX' }]
    const surfaceWinds = new Map([['ESXX', { dirDeg: 180, speedKt: 22, gustKt: null, variable: false, calm: false }]])
    const w = computeWarnings(profile(), [], ac({ maxCrosswindKts: 15 }), wps, [], undefined, false, undefined, undefined, { aerodromes, surfaceWinds })
    expect(codes(w)).toContain('crosswind')
  })
})
