/**
 * useWindAlongRoute (native) — mirrors apps/web/src/hooks/useWindAlongRoute.ts.
 * Regular-interval wind samples along the planned route, independent of
 * aerodrome positions. Complements useWeatherAlongRoute's real-station
 * markers (which only ever exist wherever an aerodrome happens to sit).
 */

import { useState, useEffect } from 'react'
import type { RouteWaypoint } from '@open-vfr/shared/types'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import { regularIntervalDistances, coordinateAlongRouteNm } from '@open-vfr/shared/virtualRadarCalc'
import {
  fetchWxResolvedForPoint, decodeMetar, parseMetarWind,
  type WxStationCandidate, type ParsedWind,
} from '@open-vfr/shared/fetchWx'
import { API_BASE, getTileUrls } from '../config'
import { authHeaders } from '../utils/authClient'

const SAMPLE_INTERVAL_NM = 15
const MAX_SAMPLES        = 6
const SEARCH_CANDIDATES  = 6

export interface WindSample {
  distNm:     number
  wind:       ParsedWind
  isModel:    boolean
  sourceIcao: string | null
}

interface AerodromeRecord { icao: string; name: string; lat: number; lng: number }

export function useWindAlongRoute(waypoints: RouteWaypoint[], totalNm: number, enabled = true): WindSample[] {
  const [aerodromes, setAerodromes] = useState<AerodromeRecord[]>([])
  const [samples, setSamples] = useState<WindSample[]>([])

  useEffect(() => {
    if (!enabled) return
    fetch(getTileUrls().aerodromes)
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
  }, [enabled])

  useEffect(() => {
    if (!enabled || waypoints.length < 2 || aerodromes.length === 0 || totalNm <= 0) { setSamples([]); return }

    const distances = regularIntervalDistances(totalNm, SAMPLE_INTERVAL_NM, MAX_SAMPLES)
    if (distances.length === 0) { setSamples([]); return }

    let cancelled = false

    async function run() {
      const headers = await authHeaders()
      const results = await Promise.all(distances.map(async (distNm): Promise<WindSample | null> => {
        const pos = coordinateAlongRouteNm(waypoints, distNm)
        const nearby: WxStationCandidate[] = aerodromes
          .map((a) => ({ icao: a.icao, distNm: distanceNm(pos, a) }))
          .sort((x, y) => x.distNm - y.distNm)

        try {
          const wx = await fetchWxResolvedForPoint(pos.lat, pos.lng, nearby, API_BASE, undefined, headers, SEARCH_CANDIDATES)

          let wind: ParsedWind | null = null
          let isModel = false
          if (wx.metar) {
            const windTok = decodeMetar(wx.metar).wind
            wind = windTok ? parseMetarWind(windTok) : null
          }
          if (!wind && wx.modelWind) {
            wind = { dirDeg: wx.modelWind.dirDeg, speedKt: wx.modelWind.speedKts, gustKt: null, variable: false, calm: wx.modelWind.speedKts === 0 }
            isModel = true
          }
          if (!wind) return null

          return { distNm, wind, isModel, sourceIcao: wx.sourceIcao }
        } catch {
          return null
        }
      }))
      if (!cancelled) setSamples(results.filter((s): s is WindSample => s != null))
    }
    void run()

    return () => { cancelled = true }
  }, [waypoints, aerodromes, totalNm, enabled])

  return samples
}
