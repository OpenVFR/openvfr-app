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
  /** Outside air temperature (°C) at the leg altitude; used for the IAS→TAS conversion. Absent = ISA. */
  oatC?:     number
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
  updatedAt: number
}

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
}
