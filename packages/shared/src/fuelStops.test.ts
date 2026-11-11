import { describe, it, expect } from 'vitest'
import { suggestFuelStops } from './fuelStops'
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

  it('reports missing profile data', () => {
    expect(suggestFuelStops(route(400), [], { ...profile, maxFuelL: 0 }, []).status).toBe('missing-profile-data')
  })
})
