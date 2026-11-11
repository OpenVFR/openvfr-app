/**
 * Shared database types — mirrors src/db/index.ts from the web project.
 *
 * These type definitions are duplicated here (rather than imported from the
 * web project) to avoid pulling in Dexie / RxDB IndexedDB bindings which
 * are browser-only APIs. The native app uses AsyncStorage for persistence.
 *
 * Keep in sync with src/db/index.ts.
 */

import type { RouteWaypoint } from './routeCalc'

export type { RouteWaypoint }

export type LegOverride = {
  altFt?:    number
  speedKts?: number
  windDir?:  number
  windSpd?:  number
}

export type AircraftCategory =
  | 'SEP' | 'MEP' | 'MICRO' | 'GYRO' | 'HELI' | 'TMG' | 'GLIDER'

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
  serviceCeilingFt: number
  rocSlFpm: number
  rocCeilingFpm: number
  climbIas: number
  climbFuelLhr: number
  descentFpm: number
  descentIas: number
  descentFuelLhr: number
  bestGlideIas: number
  glideRatio: number
  /** Takeoff speed, kt GS. 0/absent = category default. Drives auto flying-mode and flight-log detection. */
  takeoffSpeedKts?: number
  /** Diversion reserve, minutes at cruise burn. 0/absent = 30 (standard). */
  diversionMin?: number
  /** Fuel grades the engine is approved for. Absent/empty = not set (no fuel filter). */
  fuelTypes?: readonly FuelCode[]
  /** Shortest runway the pilot accepts for this aircraft, metres. 0/absent = no limit. */
  minRunwayM?: number
  /** Only paved (asphalt/concrete) runways. Absent = any surface. */
  hardRunwayOnly?: boolean
  /** Transponder fitted. Absent = not set. */
  transponder?: TransponderMode
  /** VHF radio fitted. Absent = not set. */
  hasRadio?: boolean
  /** Maximum demonstrated crosswind, kt. 0/absent = not set. */
  maxCrosswindKts?: number
  /** Climb fuel burn at the service ceiling, L/h; burn scales with altitude from `climbFuelLhr`. 0/absent = same as sea level. */
  climbFuelCeilingLhr?: number
  /** Final reserve, minutes at cruise burn, on top of the other reserves. 0/absent = none. */
  finalReserveMin?: number
  /** Unusable fuel, litres (not part of `maxFuelL`, which is usable). 0/absent = not set. */
  unusableFuelL?: number
  /** Take-off distance over a 50 ft screen, metres (max mass, sea level, ISA, paved dry). 0/absent = not set. */
  takeoffDist50ftM?: number
  /** Landing distance over a 50 ft screen, metres (same conditions). 0/absent = not set. */
  landingDist50ftM?: number
  /** V-speeds, kt IAS. 0/absent = not set. Vy is `climbIas`. */
  vs0Kts?: number
  vs1Kts?: number
  vfeKts?: number
  vaKts?: number
  vnoKts?: number
  vneKts?: number
  vxKts?: number
  /**
   * Set when an AI assistant created or changed the profile through the
   * assistant connection; cleared when the pilot saves it in the app. The app
   * marks the aircraft "check before use" while it is set.
   */
  assistantReview?: AssistantReview
  updatedAt: number
}

/** Fuel grades an aircraft profile can list. Matched against aerodrome fuel data in `fuelTypes.ts`. */
/** Who changed a profile through the assistant connection, and what. */
/** Short text for the "check before use" mark, e.g. "Added by Claude". */
export function assistantReviewLabel(r: AssistantReview): string {
  return r.change === 'created' ? `Added by ${r.by}` : `Changed by ${r.by}: ${r.change.join(', ')}`
}

export interface AssistantReview {
  /** The assistant's name (OAuth client name). */
  by: string
  /** Epoch ms. */
  at: number
  /** 'created', or the fields changed. */
  change: 'created' | readonly string[]
}

/** Transponder capability: none, mode A (code only), C (with pressure altitude) or S. */
export type TransponderMode = 'none' | 'A' | 'C' | 'S'

export type FuelCode = 'AVGAS100LL' | 'AVGAS_UL91' | 'MOGAS' | 'JETA1'

export type RouteDocType = {
  id: string
  name: string
  waypoints: RouteWaypoint[]
  legOverrides: LegOverride[]
  /** aircraft_profile id chosen for this route ('' or undefined = none) — same convention as web's src/db/index.ts RouteDocType.aircraftId */
  aircraftId?: string
  /** Only meaningful on the id='current' working-route doc: the id of the
   *  saved route (routes collection row) this working copy was loaded from,
   *  or '' if the working route is untitled / not linked to any saved row.
   *  Lets "Save" update that same row instead of guessing by name — same
   *  convention as web's src/db/index.ts RouteDocType.linkedRouteId. */
  linkedRouteId?: string
  updatedAt: number
}

export type UserWaypointDocType = {
  id: string
  name: string
  lng: number
  lat: number
  folder: string
  updatedAt: number
}

export type SettingsDocType = {
  id: string
  value: string  // JSON-encoded payload — matches web
}

export type TrackPoint = {
  lat:    number
  lng:    number
  altFt:  number
  spdKts: number
  trkDeg: number
  ts:     number
}

export type FlightLogDocType = {
  id:            string
  startedAt:     number
  endedAt:       number
  aircraftId:    string
  registration:  string
  trackJson:     string  // JSON.stringify(TrackPoint[])
  departureIcao: string
  arrivalIcao:   string
  distanceNm:    number
  maxAltFt:      number
  updatedAt:     number
  /** Recorded from simulator positions (Simulate mode or an external
   *  simulator), only when the "Record simulated flights" setting is on.
   *  Kept on the device: never synced, left out of totals. Absent = real. */
  simulated?:    boolean
  /** Planned route at the time of the flight (FlightLogRoute as JSON); absent when none. */
  routeJson?:    string
}
