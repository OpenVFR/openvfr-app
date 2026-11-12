/**
 * A browser database made before the assistant work (aircraft schema v4,
 * routes v6) must open with the current schemas: every profile and route is
 * kept as it was, the new optional fields are simply absent, and a profile
 * with the new fields can be stored next to the old ones.
 */
import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { createRxDatabase, addRxPlugin, type RxJsonSchema } from 'rxdb'
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie'
import { RxDBMigrationSchemaPlugin } from 'rxdb/plugins/migration-schema'
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder'

addRxPlugin(RxDBMigrationSchemaPlugin)
addRxPlugin(RxDBQueryBuilderPlugin)
const keep = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, (d: unknown) => d]))

const OLD_AIRCRAFT_SCHEMA: RxJsonSchema<Record<string, unknown>> = {
  title: 'aircraft_profile', version: 4, primaryKey: 'id', type: 'object',
  properties: {
    id: { type: 'string', maxLength: 64 }, name: { type: 'string', maxLength: 200 }, registration: { type: 'string', maxLength: 20 },
    icaoType: { type: 'string', maxLength: 10 }, category: { type: 'string', maxLength: 10 },
    cruiseAltFt: { type: 'number' }, cruiseIas: { type: 'number' }, fuelBurnLhr: { type: 'number' }, maxFuelL: { type: 'number' },
    taxiFuelL: { type: 'number' }, landingFuelL: { type: 'number' }, holdingMin: { type: 'number' }, contingencyPct: { type: 'number' },
    serviceCeilingFt: { type: 'number' }, rocSlFpm: { type: 'number' }, rocCeilingFpm: { type: 'number' }, climbIas: { type: 'number' },
    climbFuelLhr: { type: 'number' }, descentFpm: { type: 'number' }, descentIas: { type: 'number' }, descentFuelLhr: { type: 'number' },
    bestGlideIas: { type: 'number' }, glideRatio: { type: 'number' }, takeoffSpeedKts: { type: 'number' }, diversionMin: { type: 'number' },
    updatedAt: { type: 'number' },
  },
  required: ['id', 'name', 'registration', 'icaoType', 'category', 'cruiseAltFt', 'cruiseIas', 'fuelBurnLhr', 'maxFuelL', 'taxiFuelL',
    'landingFuelL', 'holdingMin', 'contingencyPct', 'serviceCeilingFt', 'rocSlFpm', 'rocCeilingFpm', 'climbIas', 'climbFuelLhr',
    'descentFpm', 'descentIas', 'descentFuelLhr', 'bestGlideIas', 'glideRatio', 'updatedAt'],
}
const OLD_ROUTE_SCHEMA: RxJsonSchema<Record<string, unknown>> = {
  title: 'route', version: 6, primaryKey: 'id', type: 'object',
  properties: {
    id: { type: 'string', maxLength: 64 }, name: { type: 'string', maxLength: 200 },
    waypoints: { type: 'array', items: { type: 'object', properties: { lng: { type: 'number' }, lat: { type: 'number' }, name: { type: 'string' }, note: { type: 'string' } }, required: ['lng', 'lat'] } },
    legOverrides: { type: 'array', items: { type: 'object', properties: { altFt: { type: 'number' }, speedKts: { type: 'number' }, windDir: { type: 'number' }, windSpd: { type: 'number' } } } },
    aircraftId: { type: 'string', maxLength: 64 }, linkedRouteId: { type: 'string', maxLength: 64 }, updatedAt: { type: 'number' },
  },
  required: ['id', 'name', 'waypoints', 'legOverrides', 'updatedAt'],
}

const OLD_PROFILE = {
  id: 'ac-old', name: 'Old 172', registration: 'SE-OLD', icaoType: 'C172', category: 'SEP' as const, cruiseAltFt: 3000, cruiseIas: 100, fuelBurnLhr: 30,
  maxFuelL: 150, taxiFuelL: 2, landingFuelL: 0, holdingMin: 0, contingencyPct: 10, serviceCeilingFt: 13000, rocSlFpm: 700, rocCeilingFpm: 100,
  climbIas: 75, climbFuelLhr: 40, descentFpm: 500, descentIas: 90, descentFuelLhr: 20, bestGlideIas: 68, glideRatio: 9, takeoffSpeedKts: 55,
  diversionMin: 30, updatedAt: 1_700_000_000_000,
}
const OLD_ROUTE = {
  id: 'rt-old', name: 'Old route', updatedAt: 1_700_000_000_000, aircraftId: 'ac-old', linkedRouteId: '',
  waypoints: [{ lng: 17.94, lat: 59.35, name: 'ESSB' }, { lng: 16.95, lat: 58.79, name: 'ESKN', note: 'fuel' }],
  legOverrides: [{ altFt: 3500 }],
}

describe('a browser database from before the assistant work', () => {
  it('opens with the current schemas and keeps every profile and route', async () => {
    const old = await createRxDatabase({ name: 'openvfr', storage: getRxStorageDexie(), multiInstance: false })
    await old.addCollections({ aircraft_profiles: { schema: OLD_AIRCRAFT_SCHEMA, migrationStrategies: keep(4) }, routes: { schema: OLD_ROUTE_SCHEMA, migrationStrategies: keep(6) } })
    await old.collections['aircraft_profiles']!.insert(OLD_PROFILE)
    await old.collections['routes']!.insert(OLD_ROUTE)
    await old.close()

    const { getDb } = await import('./index')
    const db = await getDb()
    const ac = (await db.aircraft_profiles.findOne('ac-old').exec())!.toJSON()
    expect(ac).toMatchObject(OLD_PROFILE)
    for (const k of ['fuelTypes', 'minRunwayM', 'maxCrosswindKts', 'takeoffDist50ftM', 'vs0Kts', 'assistantReview', 'equipment', 'adsb', 'wakeCategory', 'colour', 'modeSHex']) expect(ac).not.toHaveProperty(k)
    const rt = (await db.routes.findOne('rt-old').exec())!.toJSON()
    expect(rt).toMatchObject({ id: 'rt-old', name: 'Old route', aircraftId: 'ac-old', legOverrides: [{ altFt: 3500 }] })
    expect(rt.waypoints[1]).toMatchObject({ name: 'ESKN', note: 'fuel' })
    expect(rt.assistantReview ?? null).toBeNull()

    // A profile with the new fields sits next to the old one and both survive an edit.
    await db.aircraft_profiles.insert({
      ...OLD_PROFILE, id: 'ac-new', registration: 'SE-NEW', fuelTypes: ['AVGAS100LL'], maxCrosswindKts: 15, takeoffDist50ftM: 400, vs0Kts: 45,
      assistantReview: { by: 'Test', at: 1, change: 'created' },
      equipment: ['V', 'G'], adsb: 'B1', wakeCategory: 'L', colour: 'White', modeSHex: '4A1B2C',
    })
    const fresh = (await db.aircraft_profiles.findOne('ac-new').exec())!.toJSON()
    expect(fresh.fuelTypes).toEqual(['AVGAS100LL'])
    expect(fresh.assistantReview).toEqual({ by: 'Test', at: 1, change: 'created' })
    expect(fresh).toMatchObject({ equipment: ['V', 'G'], adsb: 'B1', wakeCategory: 'L', colour: 'White', modeSHex: '4A1B2C' })
    await (await db.aircraft_profiles.findOne('ac-old').exec())!.patch({ maxCrosswindKts: 12, updatedAt: 2 })
    expect((await db.aircraft_profiles.findOne('ac-old').exec())!.toJSON()).toMatchObject({ ...OLD_PROFILE, maxCrosswindKts: 12, updatedAt: 2 })
    expect((await db.aircraft_profiles.find().exec()).length).toBe(2)
  }, 60_000)
})
