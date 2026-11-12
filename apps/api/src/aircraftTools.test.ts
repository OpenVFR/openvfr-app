import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAircraft, AircraftInputError } from './aircraftTools.js'

const opts = { newId: '11111111-1111-4111-8111-111111111111', by: 'Claude', now: 1_000 }

test('creates a profile from POH values, with reserve defaults and the review mark', () => {
  const r = buildAircraft({
    registration: 'se-abc', icaoType: 'c172', fuelTypes: ['100LL'],
    values: { cruiseIas: 110, fuelBurnLhr: 32, maxFuelL: 201, vs0Kts: 40, vs1Kts: 48, vfeKts: 85, vnoKts: 129, vneKts: 163 },
  }, opts)
  assert.equal(r.doc.registration, 'SE-ABC')
  assert.equal(r.doc.icaoType, 'C172')
  assert.equal(r.doc.name, 'C172 SE-ABC')
  assert.deepEqual(r.doc.fuelTypes, ['AVGAS100LL'])
  assert.equal(r.doc.holdingMin, 30)
  assert.ok(r.defaults.includes('contingencyPct 10'))
  assert.deepEqual(r.warnings, [])
  assert.deepEqual(r.doc.assistantReview, { by: 'Claude', at: 1_000, change: 'created' })
})

test('flags values that look wrong but still saves them', () => {
  const r = buildAircraft({ registration: 'SE-ABC', values: { cruiseIas: 100, fuelBurnLhr: 30, maxFuelL: 150, vnoKts: 170, vneKts: 160 } }, opts)
  assert.ok(r.warnings.some(w => w.startsWith('vnoKts')))
})

test('refuses impossible input', () => {
  assert.throws(() => buildAircraft({ values: { cruiseIas: 100, fuelBurnLhr: 30, maxFuelL: 150 } }, opts), AircraftInputError)
  assert.throws(() => buildAircraft({ registration: 'SE-ABC', values: { cruiseIas: 100, fuelBurnLhr: 30, maxFuelL: -5 } }, opts), /maxFuelL must be/)
  assert.throws(() => buildAircraft({ registration: 'SE-ABC', values: { cruiseIas: 100 } }, opts), /needs cruiseIas, fuelBurnLhr and maxFuelL/)
})

test('an update changes only the given fields and lists them', () => {
  const existing = buildAircraft({ registration: 'SE-ABC', values: { cruiseIas: 100, fuelBurnLhr: 30, maxFuelL: 150 } }, opts).doc
  delete existing.assistantReview
  const r = buildAircraft({ values: { maxCrosswindKts: 15 }, hasRadio: true }, { ...opts, existing, now: 2_000 })
  assert.equal(r.doc.cruiseIas, 100)
  assert.equal(r.doc.maxCrosswindKts, 15)
  assert.deepEqual(r.doc.assistantReview?.change, ['maxCrosswindKts', 'hasRadio'])
  assert.equal(r.doc.id, existing.id)
})

test('an unreviewed profile stays "created" and unreviewed changes add up', () => {
  const made = buildAircraft({ registration: 'SE-NEW', values: { cruiseIas: 100, fuelBurnLhr: 30, maxFuelL: 100 } }, { newId: 'n', by: 'A', now: 1 })
  const a = buildAircraft({ values: { maxCrosswindKts: 15 } }, { existing: made.doc, newId: 'n', by: 'B', now: 2 })
  assert.equal(a.doc.assistantReview?.change, 'created')
  const reviewed = { ...made.doc, assistantReview: undefined }
  const b = buildAircraft({ values: { maxCrosswindKts: 15 } }, { existing: reviewed, newId: 'n', by: 'B', now: 3 })
  const c = buildAircraft({ hasRadio: true }, { existing: b.doc, newId: 'n', by: 'B', now: 4 })
  assert.deepEqual(c.doc.assistantReview?.change, ['maxCrosswindKts', 'hasRadio'])
})

test('flight plan fields: equipment letters are cleaned, the ICAO type normalised, a bad Mode S address refused', () => {
  const ctx = { newId: 'n', by: 'Claude', now: 1 }
  const b = buildAircraft({ registration: 'SE-ABC', values: { cruiseIas: 100, fuelBurnLhr: 30, maxFuelL: 100 }, icaoType: 'c-172', equipment: ['g', 'V', 'o', 'v'], adsb: 'B1', wakeCategory: 'L', colour: ' White ', modeSHex: '4a1b2c' }, ctx)
  assert.equal(b.doc.icaoType, 'C172')
  assert.deepEqual(b.doc.equipment, ['G', 'O', 'V'])
  assert.equal(b.doc.adsb, 'B1')
  assert.equal(b.doc.colour, 'White')
  assert.equal(b.doc.modeSHex, '4A1B2C')
  assert.throws(() => buildAircraft({ registration: 'SE-ABC', values: { cruiseIas: 100, fuelBurnLhr: 30, maxFuelL: 100 }, modeSHex: 'xyz' }, ctx), AircraftInputError)
  assert.throws(() => buildAircraft({ registration: 'SE-ABC', values: { cruiseIas: 100, fuelBurnLhr: 30, maxFuelL: 100 }, equipment: ['Q'] }, ctx), AircraftInputError)
})
