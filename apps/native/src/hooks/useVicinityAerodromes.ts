/**
 * useVicinityAerodromes — the aerodrome list backing VicinityBriefSheet's
 * Wx/NOTAM aerodrome picker.
 *
 * Source of the list:
 *  - Route marked Active (routeVisible, RouteContext's own "Active"/
 *    "Inactive" toggle -- native PlanScreen.tsx's header button, web
 *    MapView.tsx's "Show/Hide route" toolbar button) + route planned ->
 *    aerodromes near the planned route (same lateral-buffer match as
 *    useWeatherAlongRoute.ts), ordered by distance from the route.
 *    Deliberately keyed on routeVisible, NOT on `flying` (GPS/Simulate-
 *    detected motion) -- routeVisible is the pilot's own explicit
 *    active/inactive call for the loaded route (independent of whether a
 *    flight happens to be underway right now), and a route sitting loaded
 *    but marked Inactive shouldn't override "what's actually near me"
 *    just because the pilot happens to be moving. NOTE: routeVisible is
 *    NOT persisted (`useState(true)` in useRoute.ts/MapView.tsx) -- it
 *    resets to Active on every app restart regardless of what was last set.
 *  - Otherwise (route Inactive, or no route loaded) -> nearest aerodromes
 *    to the current/last-known GPS position within RADIUS_NM, same radius
 *    as FrequencyPanel's useNearbyFrequencies.ts (unchanged, Freq tab
 *    still uses that hook directly).
 *  - No GPS fix and no active route -> falls back to the settings-page
 *    `homeAirfield`, resolved to a single-entry list at distNm:0, so the
 *    picker still opens on a real aerodrome instead of an empty state.
 *    Wired via the optional `homeIcao` param -- callers not passing one
 *    keep the old empty-list behaviour.
 * In both cases the list is sorted closest-first, so `aerodromes[0]?.icao`
 * is always the correct default picker selection.
 *
 * Loads its own copy of se-aerodromes.geojson (icao/name/lat/lng/
 * elevation/runways) rather than reusing useNearbyFrequencies.ts's or
 * useNearestAerodrome.ts's module caches -- neither carries the runway
 * list AerodromeWxSection needs for its compass/DA calc, and this is
 * already the fourth+ narrow per-purpose parser of the same file in this
 * app (useNearbyFrequencies, useNearestAerodrome, useAerodromeElevation,
 * useWeatherAlongRoute). `loadFullVicinityAerodromes` is exported so any
 * future consumer needing the full shape reuses this one instead of
 * adding a fifth.
 */

import { useEffect, useState } from 'react'
import type { RouteWaypoint } from '@open-vfr/shared/types'
import { nearestRoutePoint } from '@open-vfr/shared/notamRouteFilter'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import { getTileUrls } from '../config'
import { onActiveCountriesChange } from '@open-vfr/shared/countryData'
import { parseFreqs, type NearbyFreq } from './useNearbyFrequencies'
import type { GpsPosition } from '../utils/gpsTypes'

const RADIUS_NM      = 25   // matches useNearbyFrequencies.ts
const ROUTE_BUFFER_NM = 15  // matches useWeatherAlongRoute.ts
const MAX_AERODROMES = 15

interface Threshold {
  designator: string
  lat: number
  lon: number
  true_brg: number | null
  mag_brg: number | null
}

export interface VicinityRunway {
  designator: string
  length_m?: number
  surface?: string
  thresholds?: Threshold[]
}

export interface FullVicinityAerodrome {
  icao:        string
  name:        string
  lat:         number
  lng:         number
  elevationFt: number | undefined
  runways:     VicinityRunway[]
  // Parsed via useNearbyFrequencies.ts's own parseFreqs -- lets
  // VicinityBriefSheet's Freq tab fall back to this route/GPS/home-
  // prioritized list when that hook's GPS-only list is empty (see its own
  // doc comment), without a second raw-JSON parser for the same field.
  frequencies: NearbyFreq[]
}

export interface VicinityAerodrome extends FullVicinityAerodrome {
  distNm: number
}

function parseJson<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback
  if (typeof v === 'string') { try { return JSON.parse(v) as T } catch { return fallback } }
  return v as T
}

let _cache: FullVicinityAerodrome[] | null = null
let _loading = false
// Per-country data: a new active country starts a fresh load.
onActiveCountriesChange(() => { _cache = null; _loading = false })
const _listeners: Array<(d: FullVicinityAerodrome[]) => void> = []

export function loadFullVicinityAerodromes(cb: (d: FullVicinityAerodrome[]) => void) {
  if (_cache) { cb(_cache); return }
  _listeners.push(cb)
  if (_loading) return
  _loading = true
  fetch(getTileUrls().aerodromes)
    .then((r) => r.json())
    .then((fc: GeoJSON.FeatureCollection) => {
      const arr: FullVicinityAerodrome[] = []
      for (const f of fc.features) {
        if (f.geometry.type !== 'Point') continue
        const p = f.properties as Record<string, unknown>
        const icao = String(p.icao ?? '').trim()
        if (!icao) continue
        const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates
        arr.push({
          icao,
          name:        String(p.name ?? ''),
          lat, lng,
          elevationFt: typeof p.elevation_ft === 'number' ? p.elevation_ft : Number(p.elevation_ft) || undefined,
          runways:     parseJson<VicinityRunway[]>(p.runways, []),
          frequencies: parseFreqs(p.frequencies),
        })
      }
      _cache = arr
      _loading = false
      _listeners.forEach((l) => l(arr))
      _listeners.length = 0
    })
    .catch(() => { _loading = false })
}

interface Opts {
  waypoints:     RouteWaypoint[]
  position:      GpsPosition | null
  /** RouteContext's own Active/Inactive toggle -- see doc comment above. */
  routeVisible:  boolean
  /** Settings-page home airfield ICAO -- last-resort fallback, see doc comment above. */
  homeIcao?:     string
}

export function useVicinityAerodromes({ waypoints, position, routeVisible, homeIcao }: Opts): VicinityAerodrome[] {
  const [all, setAll] = useState<FullVicinityAerodrome[]>([])

  useEffect(() => { loadFullVicinityAerodromes(setAll) }, [])

  const useRoute = routeVisible && waypoints.length > 0

  if (all.length === 0) return []

  if (useRoute) {
    // Sorted by along-route position (flight sequence, departure ->
    // destination), NOT by lateral/cross-track distance -- two aerodromes
    // can sit equally close to the route line while being at opposite
    // ends of it, and "closest first" then reads as a scrambled, seemingly
    // random order to a pilot expecting "in the order I'll pass them".
    // `distNm` itself keeps its existing lateral-distance meaning (still
    // shown in the picker chip as "how close to the route"), only the sort
    // key changes. Mirrors web's identical fix in its own
    // useVicinityAerodromes.ts.
    return all
      .map((a) => {
        const pos = nearestRoutePoint({ lat: a.lat, lng: a.lng }, waypoints)
        return { ...a, distNm: pos.lateralNm, alongNm: pos.alongNm }
      })
      .filter((a) => a.distNm <= ROUTE_BUFFER_NM)
      .sort((a, b) => a.alongNm - b.alongNm)
      .slice(0, MAX_AERODROMES)
  }

  if (position) {
    const nearby = all
      .map((a) => ({ ...a, distNm: distanceNm({ lat: position.lat, lng: position.lng }, { lat: a.lat, lng: a.lng }) }))
      .filter((a) => a.distNm <= RADIUS_NM)
      .sort((a, b) => a.distNm - b.distNm)
      .slice(0, MAX_AERODROMES)
    if (nearby.length > 0) return nearby
  }

  if (homeIcao) {
    const home = all.find((a) => a.icao === homeIcao)
    if (home) return [{ ...home, distNm: 0 }]
  }

  return []
}
