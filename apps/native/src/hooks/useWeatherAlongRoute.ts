/**
 * useWeatherAlongRoute (native) — mirrors apps/web/src/hooks/useWeatherAlongRoute.ts,
 * using native's bearer-token auth (authHeaders()) instead of the browser's
 * cookie-based credentials.
 */

import { useState, useEffect } from 'react'
import type { RouteWaypoint } from '@open-vfr/shared/types'
import { distanceToRouteNm } from '@open-vfr/shared/notamRouteFilter'
import { fetchWx, decodeMetar, type MetarDecoded } from '@open-vfr/shared/fetchWx'
import { API_BASE, TILE_URLS } from '../config'
import { authHeaders } from '../utils/authClient'

const BUFFER_NM    = 15
const MAX_STATIONS = 12

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

  useEffect(() => {
    fetch(TILE_URLS.aerodromes)
      .then((r) => r.json())
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

    async function run() {
      const headers = await authHeaders()
      const results = await Promise.all(nearby.map(async (a): Promise<RouteWeatherStation> => {
        try {
          const wx = await fetchWx(a.icao, API_BASE, undefined, headers)
          return {
            icao: a.icao, name: a.name, distNm: Math.round(a.distNm * 10) / 10,
            metar: wx.metar, taf: wx.taf,
            decoded: wx.metar ? decodeMetar(wx.metar) : null,
          }
        } catch {
          return { icao: a.icao, name: a.name, distNm: Math.round(a.distNm * 10) / 10, metar: null, taf: null, decoded: null }
        }
      }))
      if (!cancelled) setStations(results)
    }
    void run()

    return () => { cancelled = true }
  }, [waypoints, aerodromes])

  return stations
}
