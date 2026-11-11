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
