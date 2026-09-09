import { createRxDatabase, addRxPlugin, type RxDatabase, type RxCollection, type RxJsonSchema } from 'rxdb'
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie'
import { RxDBMigrationSchemaPlugin } from 'rxdb/plugins/migration-schema'
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder'
import type { RouteWaypoint } from '../utils/routeCalc'

addRxPlugin(RxDBMigrationSchemaPlugin)
addRxPlugin(RxDBQueryBuilderPlugin)

// This console warning ("RxDB Open Core RxStorage") is expected and harmless:
// we intentionally use RxDB's free open-core Dexie.js storage (Apache-2.0),
// not the paid rxdb-premium plugin. setPremiumFlag() to silence it lives INSIDE
// rxdb-premium itself (license-token-gated package we don't install/purchase),
// so it cannot be called from the free tier. Same reasoning as native's
// RxDB-SQLite-adapter decision — see docs/todo.md's "RxDB SQLite adapter" entry
// and docs/architecture.md's local-DB row. Leave the log as-is; do not add
// rxdb-premium as a dependency just to mute a console message.

// ---------------------------------------------------------------------------
// Collection: routes
// Stores named flight plans. The live working route uses id='current'.
// ---------------------------------------------------------------------------

/**
 * Per-leg overrides set via the Leg Properties panel.
 * All fields are optional — absent means "use global default / not set".
 * Index corresponds to the leg index (waypoints[i] → waypoints[i+1]).
 */
export type LegOverride = {
  altFt?:    number   // target cruise altitude in ft AMSL
  speedKts?: number   // cruise IAS in knots
  windDir?:  number   // wind FROM direction, degrees true (0–359)
  windSpd?:  number   // wind speed in knots
}

export type RouteDocType = {
  id: string
  name: string
  waypoints: RouteWaypoint[]
  legOverrides: LegOverride[]
  aircraftId?: string  // optional aircraft_profile id chosen for this route
  updatedAt: number
}

const routeSchema: RxJsonSchema<RouteDocType> = {
  title: 'route',
  version: 3,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id:         { type: 'string', maxLength: 64 },
    name:       { type: 'string', maxLength: 200 },
    waypoints:  {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          lng:  { type: 'number' },
          lat:  { type: 'number' },
          name: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['lng', 'lat'],
      },
    },
    legOverrides: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          altFt:    { type: 'number' },
          speedKts: { type: 'number' },
          windDir:  { type: 'number' },
          windSpd:  { type: 'number' },
        },
      },
    },
    aircraftId: { type: 'string', maxLength: 64 },
    updatedAt: { type: 'number' },
  },
  required: ['id', 'name', 'waypoints', 'legOverrides', 'updatedAt'],
}

// ---------------------------------------------------------------------------
// Collection: aircraft_profiles (Phase 2.3)
// ---------------------------------------------------------------------------

/**
 * Broad aircraft category — drives which form fields are shown and how
 * performance/fuel calculations are applied.
 */
export type AircraftCategory =
  | 'SEP'    // Single Engine Piston
  | 'MEP'    // Multi Engine Piston
  | 'MICRO'  // Microlight / ULM / LSA
  | 'GYRO'   // Gyroplane / Autogyro
  | 'HELI'   // Helicopter
  | 'TMG'    // Touring Motor Glider
  | 'GLIDER' // Glider / Sailplane

export type AircraftProfileDocType = {
  id: string
  name: string
  registration: string
  icaoType: string
  category: AircraftCategory
  cruiseAltFt: number
  cruiseIas: number
  fuelBurnLhr: number
  maxFuelL: number
  taxiFuelL: number
  landingFuelL: number
  holdingMin: number
  contingencyPct: number
  // Climb / Descent model (v2) — 0 = not configured
  serviceCeilingFt: number  // ft AMSL
  rocSlFpm: number          // rate of climb at sea level, fpm
  rocCeilingFpm: number     // rate of climb at service ceiling, fpm
  climbIas: number          // climb IAS, kts
  climbFuelLhr: number      // fuel burn during climb, L/h
  descentFpm: number        // descent rate, fpm (positive)
  descentIas: number        // descent IAS, kts
  descentFuelLhr: number    // fuel burn during descent, L/h
  // Glide parameters (v2) — non-zero only for GLIDER / TMG
  bestGlideIas: number      // best glide IAS, kts
  glideRatio: number        // glide ratio (e.g. 30 = 30:1)
  updatedAt: number
}

const aircraftProfileSchema: RxJsonSchema<AircraftProfileDocType> = {
  title: 'aircraft_profile',
  version: 2,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id:               { type: 'string', maxLength: 64 },
    name:             { type: 'string', maxLength: 200 },
    registration:     { type: 'string', maxLength: 20 },
    icaoType:         { type: 'string', maxLength: 10 },
    category:         { type: 'string', maxLength: 10 },
    cruiseAltFt:      { type: 'number' },
    cruiseIas:        { type: 'number' },
    fuelBurnLhr:      { type: 'number' },
    maxFuelL:         { type: 'number' },
    taxiFuelL:        { type: 'number' },
    landingFuelL:     { type: 'number' },
    holdingMin:       { type: 'number' },
    contingencyPct:   { type: 'number' },
    serviceCeilingFt: { type: 'number' },
    rocSlFpm:         { type: 'number' },
    rocCeilingFpm:    { type: 'number' },
    climbIas:         { type: 'number' },
    climbFuelLhr:     { type: 'number' },
    descentFpm:       { type: 'number' },
    descentIas:       { type: 'number' },
    descentFuelLhr:   { type: 'number' },
    bestGlideIas:     { type: 'number' },
    glideRatio:       { type: 'number' },
    updatedAt:        { type: 'number' },
  },
  required: ['id', 'name', 'registration', 'icaoType', 'category', 'cruiseAltFt', 'cruiseIas',
             'fuelBurnLhr', 'maxFuelL', 'taxiFuelL', 'landingFuelL',
             'holdingMin', 'contingencyPct',
             'serviceCeilingFt', 'rocSlFpm', 'rocCeilingFpm', 'climbIas', 'climbFuelLhr',
             'descentFpm', 'descentIas', 'descentFuelLhr',
             'bestGlideIas', 'glideRatio',
             'updatedAt'],
}

// ---------------------------------------------------------------------------
// Collection: user_waypoints (Phase 2 — custom waypoints)
// ---------------------------------------------------------------------------
export type UserWaypointDocType = {
  id: string
  name: string
  lng: number
  lat: number
  folder: string
  updatedAt: number
}

const userWaypointSchema: RxJsonSchema<UserWaypointDocType> = {
  title: 'user_waypoint',
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id:        { type: 'string', maxLength: 64 },
    name:      { type: 'string', maxLength: 200 },
    lng:       { type: 'number' },
    lat:       { type: 'number' },
    folder:    { type: 'string', maxLength: 100 },
    updatedAt: { type: 'number' },
  },
  required: ['id', 'name', 'lng', 'lat', 'folder', 'updatedAt'],
}

// ---------------------------------------------------------------------------
// Collection: tile_manifest (Phase 2 — AIRAC/region tracking)
// Primary key is a composite e.g. "se:ofmx" or "se:obstacles"
// ---------------------------------------------------------------------------
export type TileManifestDocType = {
  id: string
  country: string
  source: string
  airacCycle: string
  cachedAt: number
}

const tileManifestSchema: RxJsonSchema<TileManifestDocType> = {
  title: 'tile_manifest',
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id:         { type: 'string', maxLength: 32 },
    country:    { type: 'string', maxLength: 4 },
    source:     { type: 'string', maxLength: 32 },
    airacCycle: { type: 'string', maxLength: 10 },
    cachedAt:   { type: 'number' },
  },
  required: ['id', 'country', 'source', 'airacCycle', 'cachedAt'],
}

// ---------------------------------------------------------------------------
// Collection: settings (key-value store for app-wide preferences)
// id examples: 'home_airfield', 'units'
// ---------------------------------------------------------------------------
export type SettingsDocType = {
  id: string
  value: string // JSON-encoded payload
}

const settingsSchema: RxJsonSchema<SettingsDocType> = {
  title: 'settings',
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id:    { type: 'string', maxLength: 64 },
    value: { type: 'string', maxLength: 4096 },
  },
  required: ['id', 'value'],
}

// ---------------------------------------------------------------------------
// Collection: flight_logs (Phase 3 — GPS track recording)
// One document per flight. Track points stored as a flat number array:
//   [lat0, lng0, altFt0, speedKts0, trackDeg0, timestamp0_ms,  lat1, …]
// Stored as JSON string to avoid RxDB nestedArray limits.
// ---------------------------------------------------------------------------
export type FlightLogDocType = {
  id:               string   // UUID
  startedAt:        number   // Unix ms — takeoff detection
  endedAt:          number   // Unix ms — landing detection (0 = in-progress)
  aircraftId:       string   // aircraft_profile id ('' if none selected)
  registration:     string   // snapshot of registration at time of flight
  trackJson:        string   // JSON.stringify of TrackPoint[]
  departureIcao:    string   // nearest aerodrome at takeoff ('' if unknown)
  arrivalIcao:      string   // nearest aerodrome at landing ('' if unknown)
  distanceNm:       number   // accumulated great-circle distance
  maxAltFt:         number   // highest GPS alt recorded
  updatedAt:        number
}

export type TrackPoint = {
  lat:     number
  lng:     number
  altFt:   number
  spdKts:  number
  trkDeg:  number
  ts:      number  // Unix ms
}

const flightLogSchema: RxJsonSchema<FlightLogDocType> = {
  title: 'flight_log',
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id:           { type: 'string', maxLength: 64 },
    startedAt:    { type: 'number' },
    endedAt:      { type: 'number' },
    aircraftId:   { type: 'string', maxLength: 64 },
    registration: { type: 'string', maxLength: 20 },
    trackJson:    { type: 'string', maxLength: 2_000_000 },
    departureIcao: { type: 'string', maxLength: 10 },
    arrivalIcao:   { type: 'string', maxLength: 10 },
    distanceNm:    { type: 'number' },
    maxAltFt:      { type: 'number' },
    updatedAt:     { type: 'number' },
  },
  required: ['id', 'startedAt', 'endedAt', 'aircraftId', 'registration',
             'trackJson', 'departureIcao', 'arrivalIcao',
             'distanceNm', 'maxAltFt', 'updatedAt'],
}

// ---------------------------------------------------------------------------
// DB type + singleton
// ---------------------------------------------------------------------------
type OpenVfrCollections = {
  routes:            RxCollection<RouteDocType>
  aircraft_profiles: RxCollection<AircraftProfileDocType>
  user_waypoints:    RxCollection<UserWaypointDocType>
  tile_manifest:     RxCollection<TileManifestDocType>
  settings:          RxCollection<SettingsDocType>
  flight_logs:       RxCollection<FlightLogDocType>
}

export type OpenVfrDb = RxDatabase<OpenVfrCollections>

let _dbPromise: Promise<OpenVfrDb> | null = null

export function getDb(): Promise<OpenVfrDb> {
  if (!_dbPromise) {
    _dbPromise = createRxDatabase<OpenVfrCollections>({
      name: 'openvfr',
      storage: getRxStorageDexie(),
      multiInstance: false,
    }).then(db =>
      db.addCollections({
        routes: {
          schema: routeSchema,
          migrationStrategies: {
            // v0 → v1: add legOverrides field (default empty array)
            1: (oldDoc) => ({ ...oldDoc, legOverrides: [] }),
            // v1 → v2: add optional note field to waypoints (no data migration needed)
            2: (oldDoc) => ({ ...oldDoc }),
            // v2 → v3: add optional aircraftId field (unset for existing routes)
            3: (oldDoc) => ({ ...oldDoc, aircraftId: oldDoc.aircraftId ?? '' }),
          },
        },
        aircraft_profiles: {
          schema: aircraftProfileSchema,
          migrationStrategies: {
            // v0 → v1: add category field (default to SEP for existing profiles)
            1: (oldDoc) => ({ ...oldDoc, category: 'SEP' }),
            // v1 → v2: add climb/descent model + glide parameters (all zeroed = not configured)
            2: (oldDoc) => ({
              ...oldDoc,
              serviceCeilingFt: 0,
              rocSlFpm:         0,
              rocCeilingFpm:    0,
              climbIas:         0,
              climbFuelLhr:     0,
              descentFpm:       0,
              descentIas:       0,
              descentFuelLhr:   0,
              bestGlideIas:     0,
              glideRatio:       0,
            }),
          },
        },
        user_waypoints:    { schema: userWaypointSchema },
        tile_manifest:     { schema: tileManifestSchema },
        settings:          { schema: settingsSchema },
        flight_logs:       { schema: flightLogSchema },
      }).then(() => db)
    )
  }
  return _dbPromise
}
