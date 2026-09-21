/**
 * useVicinityAerodromes — the aerodrome list backing VicinityBriefSheet's
 * Wx/NOTAM aerodrome picker.
 *
 * Source of the list:
 *  - Flying + route planned  -> aerodromes near the planned route (same
 *    lateral-buffer match as useWeatherAlongRoute.ts), ordered by distance
 *    from the route.
 *  - Otherwise (idle, or flying with no route) -> nearest aerodromes to
 *    the current/last-known GPS position within RADIUS_NM, same radius as
 *    FrequencyPanel's useNearbyFrequencies.ts (unchanged, Freq tab still
 *    uses that hook directly).
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
import { distanceToRouteNm } from '@open-vfr/shared/notamRouteFilter'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import { getTileUrls } from '../config'
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
  waypoints: RouteWaypoint[]
  position:  GpsPosition | null
  flying:    boolean
}

export function useVicinityAerodromes({ waypoints, position, flying }: Opts): VicinityAerodrome[] {
  const [all, setAll] = useState<FullVicinityAerodrome[]>([])

  useEffect(() => { loadFullVicinityAerodromes(setAll) }, [])

  const useRoute = flying && waypoints.length > 0

  if (all.length === 0) return []

  if (useRoute) {
    return all
      .map((a) => ({ ...a, distNm: distanceToRouteNm({ lat: a.lat, lng: a.lng }, waypoints) }))
      .filter((a) => a.distNm <= ROUTE_BUFFER_NM)
      .sort((a, b) => a.distNm - b.distNm)
      .slice(0, MAX_AERODROMES)
  }

  if (!position) return []

  return all
    .map((a) => ({ ...a, distNm: distanceNm({ lat: position.lat, lng: position.lng }, { lat: a.lat, lng: a.lng }) }))
    .filter((a) => a.distNm <= RADIUS_NM)
    .sort((a, b) => a.distNm - b.distNm)
    .slice(0, MAX_AERODROMES)
}
