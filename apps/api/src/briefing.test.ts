import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRouteBriefing, briefingText, type BriefingDeps } from './briefing.js'
import type { AircraftProfileDocType } from '@open-vfr/shared/types'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'

const NOW = Date.UTC(2026, 10, 11, 9, 0)

const aircraft: AircraftProfileDocType = {
  id: 'a', name: 'Test', registration: 'SE-TST', icaoType: 'C172', category: 'SEP',
  cruiseAltFt: 3000, cruiseIas: 100, fuelBurnLhr: 20, maxFuelL: 60,
  taxiFuelL: 2, landingFuelL: 0, holdingMin: 0, contingencyPct: 0, diversionMin: 30,
  serviceCeilingFt: 0, rocSlFpm: 0, rocCeilingFpm: 0, climbIas: 0, climbFuelLhr: 0,
  descentFpm: 0, descentIas: 0, descentFuelLhr: 0, bestGlideIas: 0, glideRatio: 0,
  maxCrosswindKts: 12, landingDist50ftM: 400, updatedAt: 0,
}

const aerodromes: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [15, 58] }, properties: { icao: 'ESAA', name: 'ALPHA', elevation_ft: 0, runways: [{ designator: '09/27', length_m: 1500, surface: 'ASPH', thresholds: [{ designator: '09', mag_brg: 90, true_brg: 90 }, { designator: '27', mag_brg: 270, true_brg: 270 }] }] } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [15, 59] }, properties: { icao: 'ESBB', name: 'BRAVO', elevation_ft: 0, runways: [{ designator: '09/27', length_m: 500, surface: 'GRASS', thresholds: [{ designator: '09', mag_brg: 90, true_brg: 90 }, { designator: '27', mag_brg: 270, true_brg: 270 }] }] } },
  ],
}

function deps(over: Partial<BriefingDeps> = {}): BriefingDeps {
  return {
    loadDataset: async (kind) => (kind === 'aerodromes' ? aerodromes : { type: 'FeatureCollection', features: [] }),
    regionalNotams: () => [],
    aerodromeNotams: (icao) => icao === 'ESBB'
      ? [{ id: 'A1234/26', nmsId: '1', text: 'RWY 09/27 CLSD', effective: '2026-11-10T00:00:00Z', expires: '2026-11-20T00:00:00Z', classification: null, icaoLocation: 'ESBB', qCode: 'QMRLC', polygon: null, lat: null, lon: null, radiusNm: null } as unknown as NotamItem]
      : [],
    weather: async (icao) => ({ metar: icao === 'ESBB' ? 'ESBB 110850Z 18020KT 9999 FEW030 12/05 Q1012' : 'ESAA 110850Z 27005KT CAVOK 10/02 Q1013', taf: null }),
    ...over,
  }
}

const route = [{ lat: 58, lng: 15, name: 'ESAA' }, { lat: 59, lng: 15, name: 'ESBB' }]

test('briefs a route: hops, aerodromes with weather and NOTAMs, warnings', async () => {
  const b = await buildRouteBriefing({ waypoints: route, legOverrides: [{}], aircraft, nowMs: NOW }, deps())
  assert.deepEqual(b.route.points, ['ESAA', 'ESBB'])
  assert.equal(b.hops.length, 1)
  assert.equal(b.hops[0]!.fuelOk, true)
  assert.deepEqual(b.aerodromes.map(a => [a.icao, a.role]), [['ESAA', 'departure'], ['ESBB', 'destination']])
  assert.equal(b.aerodromes[1]!.notams[0]!.id, 'A1234/26')
  const codes = b.warnings.map(w => w.title)
  assert.ok(codes.some(t => t.startsWith('Crosswind at ESBB')), 'crosswind 20 kt across, limit 12')
  assert.ok(codes.some(t => t.startsWith('Runway short for landing at ESBB')), '400 m x 1.15 x 1.43 > 500 m grass')
  assert.match(b.disclaimer, /not an official briefing/)
})

test('without an aircraft there are no hops, and it says so', async () => {
  const b = await buildRouteBriefing({ waypoints: route, legOverrides: [{}], nowMs: NOW }, deps())
  assert.equal(b.hops.length, 0)
  assert.ok(b.limits.some(l => /No aircraft profile/.test(l)))
})

test('missing data is reported, not hidden', async () => {
  const b = await buildRouteBriefing(
    { waypoints: route, legOverrides: [{}], aircraft, nowMs: NOW },
    deps({ loadDataset: async () => null, weather: async () => null }),
  )
  assert.ok(b.limits.some(l => /Airspace data could not be loaded/.test(l)))
  assert.ok(b.limits.some(l => /no current METAR/.test(l)))
  assert.equal(b.aerodromes[0]!.metar, null)
})

test('says NOTAMs were not checked when the NOTAM data is missing', async () => {
  const b = await buildRouteBriefing({ waypoints: route, legOverrides: [{}], aircraft, nowMs: NOW }, deps({ notamStatus: () => ({ available: false, asOf: null }) }))
  assert.ok(b.limits.some(l => /no NOTAMs were checked/.test(l)))
  assert.equal(b.aerodromes[0]!.notamsChecked, false)
  assert.match(briefingText(b), /NOTAMs not checked/)
})

test('text rendering lists warnings and aerodromes', async () => {
  const b = await buildRouteBriefing({ waypoints: route, legOverrides: [{}], aircraft, nowMs: NOW }, deps())
  const t = briefingText(b)
  assert.match(t, /Route ESAA → ESBB/)
  assert.match(t, /destination ESBB \(BRAVO\)/)
  assert.match(t, /Planning aid only/)
})
