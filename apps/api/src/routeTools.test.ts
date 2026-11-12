import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPointIndex, withPlaces } from '@open-vfr/shared/routeIdentifiers'
import { buildRoute, legLines, legKeys, changedLevelLegs, RouteInputError } from './routeTools.js'

const pt = (lng: number, lat: number, properties: Record<string, unknown>) => ({ geometry: { type: 'Point', coordinates: [lng, lat] }, properties })
const idx = buildPointIndex({
  aerodromes: { features: [pt(17.94, 59.35, { icao: 'ESSB', elevation_ft: 47 }), pt(16.95, 58.79, { icao: 'ESKN', elevation_ft: 140 }), pt(14.5, 56.3, { icao: 'ESMS', elevation_ft: 236 })] },
  navaids: { features: [pt(17.9, 59.6, { id: 'ARL' })] },
  waypoints: { features: [pt(17.3, 62.6, { id: 'NORTH', aerodrome: 'ESNV' }), pt(14.8, 63.3, { id: 'NORTH', aerodrome: 'ESPE' })] },
})
const ctx = { idx, newId: 'new-id', by: 'Claude', now: 1000 }

test('creates a route with levels, a fuel stop and the review mark', () => {
  const b = buildRoute({ points: ['essb', 'ESKN', 'ESMS'], altitudeFt: 3500, legs: [{ leg: 2, altitudeFt: 4500, speedKts: 95 }], fuelStops: ['ESKN'] }, ctx)
  assert.equal(b.doc.name, 'ESSB – ESMS')
  assert.deepEqual(b.doc.legOverrides, [{ altFt: 3500 }, { altFt: 4500, speedKts: 95 }])
  assert.equal(b.doc.waypoints[1]!.fuelStop, true)
  assert.equal(b.doc.waypoints[0]!.elevationFt, 47)
  assert.deepEqual(b.doc.assistantReview, { by: 'Claude', at: 1000, change: 'created' })
  assert.match(legLines(b.doc)[0]!, /^1\. ESSB → ESKN \(fuel stop\) \d+ NM, 3500 ft$/)
})

test('refuses unknown and ambiguous points, listing all of them', () => {
  assert.throws(() => buildRoute({ points: ['ESSB', 'XXXX', 'NORTH'] }, ctx), (e: Error) =>
    e instanceof RouteInputError && /XXXX: not an aerodrome/.test(e.message) && /NORTH: ambiguous.*ESNV\/NORTH/.test(e.message))
})

test('refuses bad levels, legs and fuel stops', () => {
  assert.throws(() => buildRoute({ points: ['ESSB', 'ESMS'], altitudeFt: 90000 }, ctx), RouteInputError)
  assert.throws(() => buildRoute({ points: ['ESSB', 'ESMS'], legs: [{ leg: 2, altitudeFt: 3000 }] }, ctx), /legs are 1 to 1/)
  assert.throws(() => buildRoute({ points: ['ESSB', 'ESMS'], fuelStops: ['ESMS'] }, ctx), /not a point between/)
  assert.throws(() => buildRoute({ points: ['ESSB', 'ARL', 'ESMS'], fuelStops: ['ARL'] }, ctx), /not an aerodrome/)
  assert.throws(() => buildRoute({ points: ['ESSB', 'ESSB', 'ESMS'] }, ctx), /follows itself/)
})

test('update keeps hand-placed points and leg settings of legs that stay', () => {
  const existing = {
    id: 'r1', name: 'Trip', aircraftId: 'a1', updatedAt: 1,
    waypoints: [{ lat: 59.35, lng: 17.94, name: 'ESSB' }, { lat: 59.0, lng: 17.5, name: 'My lake', note: 'photo' }, { lat: 56.3, lng: 14.5, name: 'ESMS' }],
    legOverrides: [{ altFt: 2500 }, { altFt: 4500 }],
  }
  const b = buildRoute({ points: ['ESSB', 'My lake', 'ESKN', 'ESMS'] }, { ...ctx, existing })
  assert.equal(b.doc.id, 'r1')
  assert.equal(b.doc.waypoints[1]!.note, 'photo')
  assert.deepEqual(b.doc.legOverrides, [{ altFt: 2500 }, {}, {}])
  assert.deepEqual(b.changed, ['points'])
  assert.deepEqual(b.doc.assistantReview?.change, ['points'])
  const again = buildRoute({ name: 'Trip 2' }, { ...ctx, existing: b.doc })
  assert.deepEqual(again.doc.assistantReview?.change, ['points', 'name'])
})

test('legs between unnamed points are told apart (by position and occurrence)', () => {
  const u = (lat: number, lng: number) => ({ lat, lng })
  const doc = (alts: (number | undefined)[]) => ({
    id: 'r', name: 'R', aircraftId: '', updatedAt: 0,
    waypoints: [u(59, 17), u(59.2, 17), u(59, 17), u(59.2, 17)],   // the same pair flown twice
    legOverrides: alts.map(altFt => (altFt === undefined ? {} : { altFt })),
  })
  // Lowering only the third leg to what the first one has must still count as a change of that leg.
  assert.deepEqual(changedLevelLegs(doc([3000, 3000, 4000]), doc([3000, 3000, 3000])), [2])
  assert.deepEqual(legKeys(doc([]).waypoints).length, 3)
  assert.equal(new Set(legKeys(doc([]).waypoints)).size, 3)
})

test('update keeps a place, a landmark and a coordinate point (and their notes and leg settings) when they are written as identifiers again', () => {
  const places = withPlaces(buildPointIndex({
    aerodromes: { features: [pt(17.94, 59.35, { icao: 'ESSB', elevation_ft: 47 }), pt(14.5, 56.3, { icao: 'ESMS', elevation_ft: 236 })] },
    landmarks: { features: [pt(15.5, 57.5, { name: 'Hassela kyrka', kind: 'church' })] },
  }), [{ name: 'Cabin', lat: 59.5, lng: 17.93 }])
  const existing = {
    id: 'r1', name: 'Mixed', updatedAt: 0,
    waypoints: [
      { lat: 59.35, lng: 17.94, name: 'ESSB' },
      { lat: 59.5, lng: 17.93, name: 'Cabin', note: 'park here' },
      { lat: 57.5, lng: 15.5, name: 'Hassela kyrka' },
      { lat: 58.2, lng: 15.1, name: '58.2000N 15.1000E', note: 'bend' },
      { lat: 56.3, lng: 14.5, name: 'ESMS' },
    ],
    legOverrides: [{}, { altFt: 4000 }, {}, { altFt: 3500 }],
  }
  const b = buildRoute({ points: ['ESSB', 'PL/Cabin', 'LM/Hassela kyrka', '58.2000N 15.1000E', 'ESMS'], altitudeFt: undefined }, { ...ctx, idx: places, existing: existing as never })
  assert.equal(b.doc.waypoints[1]!.note, 'park here')
  assert.equal(b.doc.waypoints[3]!.note, 'bend')
  assert.deepEqual(b.doc.legOverrides, [{}, { altFt: 4000 }, {}, { altFt: 3500 }])
  assert.deepEqual(b.changed, [])
})
