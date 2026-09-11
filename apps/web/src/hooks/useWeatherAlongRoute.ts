/**
 * useWeatherAlongRoute — collects METAR/TAF for aerodromes near the planned
 * route into one list, mirroring SkyDemon's Weather tab ("TAF and METAR are
 * automatically retrieved for your route as you plot it, and are shown
 * decoded in the Weather window"). Complements per-airport weather already
 * shown in AerodromePopup -- this is the "along the whole route at a
 * glance" view, same relationship as RegionalNotamsPanel vs. per-airport
 * NOTAM tab.
 *
 * Buffer is wider than the NOTAM route filter (15nm vs 5nm) -- METAR
 * stations are much sparser than NOTAM-affected areas, and pilots
 * reasonably care about weather at airports a bit further off-track than
 * NOTAMs strictly along the corridor. Station count capped (12) to avoid
 * firing a large parallel burst of /api/weather requests for a long route.
 */

import { useState, useEffect } from 'react'
import type { RouteWaypoint } from '../utils/routeCalc'
import { TILES_BASE_URL, API_BASE_URL } from '../utils/env'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'
import { distanceToRouteNm } from '@open-vfr/shared/notamRouteFilter'
import { fetchWx, decodeMetar, type MetarDecoded } from '@open-vfr/shared/fetchWx'

const BUFFER_NM     = 15
const MAX_STATIONS  = 12

export interface RouteWeatherStation {
  icao:    string
  name:    string
  distNm:  number
  metar:   string | null
  taf:     string | null
  decoded: MetarDecoded | null
}

interface AerodromeRecord { icao: string; name: string; lat: number; lng: number }

export function useWeatherAlongRoute(waypoints: RouteWaypoint[]): RouteWeatherStation[] {
  const [aerodromes, setAerodromes] = useState<AerodromeRecord[]>([])
  const [stations, setStations] = useState<RouteWeatherStation[]>([])

  // Load aerodrome list once -- same static-file pattern as useAirfieldProximity.ts.
  useEffect(() => {
    fetch(versionedTileUrl(TILES_BASE_URL, 'se-aerodromes.geojson'))
      .then(r => r.json())
      .then((fc: GeoJSON.FeatureCollection) => {
        const arr: AerodromeRecord[] = []
        for (const f of fc.features) {
          if (f.geometry.type !== 'Point') continue
          const p = f.properties as Record<string, unknown>
          const icao = String(p['icao'] ?? '')
          if (!icao) continue
          const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates
          arr.push({ icao, name: String(p['name'] ?? ''), lat, lng })
        }
        setAerodromes(arr)
      })
      .catch(() => { /* offline-safe */ })
  }, [])

  useEffect(() => {
    if (waypoints.length === 0 || aerodromes.length === 0) { setStations([]); return }

    const nearby = aerodromes
      .map((a) => ({ ...a, distNm: distanceToRouteNm({ lat: a.lat, lng: a.lng }, waypoints) }))
      .filter((a) => a.distNm <= BUFFER_NM)
      .sort((a, b) => a.distNm - b.distNm)
      .slice(0, MAX_STATIONS)

    let cancelled = false
    const ac = new AbortController()

    Promise.all(nearby.map(async (a): Promise<RouteWeatherStation> => {
      try {
        const wx = await fetchWx(a.icao, API_BASE_URL, ac.signal)
        return {
          icao: a.icao, name: a.name, distNm: Math.round(a.distNm * 10) / 10,
          metar: wx.metar, taf: wx.taf,
          decoded: wx.metar ? decodeMetar(wx.metar) : null,
        }
      } catch {
        return { icao: a.icao, name: a.name, distNm: Math.round(a.distNm * 10) / 10, metar: null, taf: null, decoded: null }
      }
    })).then((results) => { if (!cancelled) setStations(results) })

    return () => { cancelled = true; ac.abort() }
  }, [waypoints, aerodromes])

  return stations
}
