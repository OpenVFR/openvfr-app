import { describe, it, expect } from 'vitest'
import { suggestFuelStops, insertFuelStops, setFuelStop } from './fuelStops'
import { computeTripFuelPlans, fuelHopRanges } from './fuelCalc'
import type { AircraftProfileDocType } from './types'
import type { AerodromeEntry } from './findDestination'

// Along a meridian 1° of latitude is 60 NM.
const LNG = 15
const at = (nm: number, offNm = 0) => ({ lat: 50 + nm / 60, lng: LNG + offNm / (60 * Math.cos((50 * Math.PI) / 180)) })

const profile: AircraftProfileDocType = {
  id: 'a', name: 'Test', registration: 'SE-TST', icaoType: 'C172', category: 'SEP',
  cruiseAltFt: 3000, cruiseIas: 100, fuelBurnLhr: 20, maxFuelL: 60,
  taxiFuelL: 2, landingFuelL: 0, holdingMin: 0, contingencyPct: 0, diversionMin: 30,
  serviceCeilingFt: 0, rocSlFpm: 0, rocCeilingFpm: 0, climbIas: 0, climbFuelLhr: 0,
  descentFpm: 0, descentIas: 0, descentFuelLhr: 0, bestGlideIas: 0, glideRatio: 0,
  fuelTypes: ['AVGAS100LL'], minRunwayM: 600, hardRunwayOnly: false,
  updatedAt: 0,
}
// Usable for flying: 60 - 2 taxi - 10 diversion = 48 L = 2.4 h, about 250 NM.

function ad(icao: string, nm: number, offNm: number, extra: Partial<AerodromeEntry> = {}): AerodromeEntry {
  return {
    icao, name: icao, ...at(nm, offNm), elevationFt: 0, maxRunwayM: 900,
    surfaces: ['ASPH'], fuel: ['AVGAS'], type: 'AD',
    runways: [{ lengthM: 900, surface: 'ASPH' }], ...extra,
  }
}

const route = (nm: number) => [{ ...at(0), name: 'DEP' }, { ...at(nm), name: 'DST' }]

describe('suggestFuelStops', () => {
  it('needs no stop when the route fits the tanks', () => {
    expect(suggestFuelStops(route(150), [], profile, [ad('MID1', 75, 2)]).status).toBe('not-needed')
  })

  it('picks the aerodrome that splits the trip, not one too early', () => {
    const ads = [
      ad('EARL', 60, 1),                        // second hop ~340 NM: too far
      ad('MIDA', 200, 3),                       // good
      ad('JETO', 200, 1, { fuel: ['A1'] }),     // wrong fuel
      ad('SHRT', 200, 0, { runways: [{ lengthM: 400, surface: 'ASPH' }], maxRunwayM: 400 }),
      ad('FARX', 200, 100),                     // detour ~47 NM: too far off track
      ad('HELI', 200, 0, { type: 'HP' }),       // heliport
    ]
    const r = suggestFuelStops(route(400), [], profile, ads)
    expect(r.status).toBe('found')
    if (r.status !== 'found') return
    expect(r.plans[0].stops.map(s => s.aerodrome.icao)).toEqual(['MIDA'])
    expect(r.plans[0].stops[0].fuels).toEqual(['AVGAS100LL'])
    expect(r.plans[0].hops).toHaveLength(2)
    for (const h of r.plans[0].hops) expect(h.minFuelL).toBeLessThanOrEqual(profile.maxFuelL)
    expect(r.plans[0].extraMins).toBeGreaterThanOrEqual(0)
    const all = r.plans.flatMap(p => p.stops.map(s => s.aerodrome.icao))
    for (const bad of ['EARL', 'JETO', 'SHRT', 'FARX', 'HELI']) expect(all).not.toContain(bad)
  })

  it('offers alternatives, best first', () => {
    const r = suggestFuelStops(route(400), [], profile, [ad('MIDA', 200, 1), ad('MIDB', 180, 8), ad('MIDC', 220, 12)])
    expect(r.status).toBe('found')
    if (r.status !== 'found') return
    expect(r.plans.length).toBe(3)
    expect(r.plans[0].stops[0].aerodrome.icao).toBe('MIDA')
    expect(r.plans[0].enrouteMins).toBeLessThanOrEqual(r.plans[1].enrouteMins)
  })

  it('chains two stops on a long route', () => {
    const r = suggestFuelStops(route(650), [], profile, [ad('S200', 200, 2), ad('S420', 420, 2), ad('S300', 300, 2)])
    expect(r.status).toBe('found')
    if (r.status !== 'found') return
    expect(r.plans[0].stops).toHaveLength(2)
  })

  it('respects paved-only', () => {
    const grass = ad('GRAS', 200, 1, { surfaces: ['GRASS'], runways: [{ lengthM: 900, surface: 'GRASS' }] })
    expect(suggestFuelStops(route(400), [], { ...profile, hardRunwayOnly: true }, [grass]).status).toBe('none-found')
    expect(suggestFuelStops(route(400), [], profile, [grass]).status).toBe('found')
  })

  it('without fuel types, takes any aerodrome that lists fuel and says so', () => {
    const r = suggestFuelStops(route(400), [], { ...profile, fuelTypes: [] }, [ad('JETO', 200, 1, { fuel: ['A1'] }), ad('NONE', 200, 0, { fuel: [] })])
    expect(r.status).toBe('found')
    if (r.status !== 'found') return
    expect(r.fuelTypesUnset).toBe(true)
    expect(r.plans[0].stops[0].aerodrome.icao).toBe('JETO')
  })

  it('prefers hops of similar length over a stop just after take-off', () => {
    const r = suggestFuelStops(route(400), [], profile, [ad('EARL', 165, 0), ad('MIDA', 200, 4)])
    expect(r.status).toBe('found')
    if (r.status !== 'found') return
    expect(r.plans[0].stops[0].aerodrome.icao).toBe('MIDA')
    // EARL alone is a possible stop: it lost on balance, not on range.
    expect(suggestFuelStops(route(400), [], profile, [ad('EARL', 165, 0)]).status).toBe('found')
  })

  it('treats a route point marked as fuel stop as a landing', () => {
    const wps = [{ ...at(0), name: 'DEP' }, { ...at(200), name: 'MIDA', fuelStop: true }, { ...at(400), name: 'DST' }]
    expect(suggestFuelStops(wps, [], profile, []).status).toBe('not-needed')
    // Not marked: one flight, too long.
    expect(suggestFuelStops(wps.map(({ fuelStop: _f, ...w }) => w), [], profile, []).status).toBe('none-found')
  })

  it('prefers a stop with the preferred fuel', () => {
    const pref = { ...profile, fuelTypes: ['MOGAS', 'AVGAS100LL'] as const }
    const ads = [ad('AVGA', 200, 1), ad('MOGA', 205, 3, { fuel: ['MOGAS'] })]
    const r = suggestFuelStops(route(400), [], pref, ads)
    expect(r.status).toBe('found')
    if (r.status !== 'found') return
    expect(r.plans[0].stops[0].aerodrome.icao).toBe('MOGA')
    expect(r.plans[0].stops[0].fuelRank).toBe(0)
    expect(r.plans.find(p => p.stops[0].aerodrome.icao === 'AVGA')?.stops[0].fuelRank).toBe(1)
    // Without a preference penalty the shorter detour wins.
    const r2 = suggestFuelStops(route(400), [], pref, ads, undefined, { fuelRankPenaltyMin: 0 })
    if (r2.status === 'found') expect(r2.plans[0].stops[0].aerodrome.icao).toBe('AVGA')
  })

  it('reports missing profile data', () => {
    expect(suggestFuelStops(route(400), [], { ...profile, maxFuelL: 0 }, []).status).toBe('missing-profile-data')
  })
})

describe('computeTripFuelPlans', () => {
  it('splits at fuel stops only', () => {
    expect(fuelHopRanges([{}, {}, {}])).toEqual([[0, 2]])
    expect(fuelHopRanges([{}, { fuelStop: true }, {}, { fuelStop: true }, {}])).toEqual([[0, 1], [1, 3], [3, 4]])
    // A flag on the first or last point is not a stop.
    expect(fuelHopRanges([{ fuelStop: true }, {}, { fuelStop: true }])).toEqual([[0, 2]])
  })
  it('plans each hop with its own taxi and reserves', () => {
    const wps = [{ ...at(0) }, { ...at(200), fuelStop: true }, { ...at(400) }]
    const hops = computeTripFuelPlans(wps, [{ altFt: 4000 }, { altFt: 5000 }], profile)
    expect(hops).toHaveLength(2)
    for (const h of hops) {
      expect(h.plan.taxiFuelL).toBe(2)
      expect(h.plan.totalMinFuelL).toBeLessThanOrEqual(60)
    }
  })
})

describe('insertFuelStops / setFuelStop', () => {
  it('inserts stops in route order with the split leg override copied', () => {
    const wps = [{ ...at(0), name: 'A' }, { ...at(300), name: 'B' }]
    const mk = (icao: string, nm: number) => ({ aerodrome: ad(icao, nm, 0), fuels: [], fuelRank: 0, insertAfter: 0, detourNm: 0 })
    const r = insertFuelStops(wps, [{ altFt: 4500 }], { stops: [mk('S1', 100), mk('S2', 200)] })
    expect(r.waypoints.map(w => w.name)).toEqual(['A', 'S1', 'S2', 'B'])
    expect(r.waypoints[1].fuelStop).toBe(true)
    expect(r.legOverrides).toEqual([{ altFt: 4500 }, { altFt: 4500 }, { altFt: 4500 }])
  })
  it('marks and clears, never on the ends', () => {
    const wps = [{ ...at(0) }, { ...at(100) }, { ...at(200) }]
    expect(setFuelStop(wps, 1, true)[1].fuelStop).toBe(true)
    expect('fuelStop' in setFuelStop(setFuelStop(wps, 1, true), 1, false)[1]).toBe(false)
    expect(setFuelStop(wps, 0, true)[0].fuelStop).toBeUndefined()
  })
})
