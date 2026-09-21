/**
 * useWindAlongRoute — regular-interval wind samples along the planned
 * route, independent of aerodrome positions. Complements
 * useWeatherAlongRoute's real-station markers (which only ever exist
 * wherever an aerodrome happens to sit): this fills the gaps between them
 * so a long leg over open terrain with no nearby airfield still gets a
 * wind indication, using the same nearest-METAR-or-model-wind tiering
 * AerodromePopup/fetchWxResolved already use elsewhere.
 *
 * Deliberately loads its own aerodrome list rather than sharing
 * useWeatherAlongRoute's fetch — the browser's HTTP cache makes the second
 * request to the same versioned URL free, and keeping the two hooks
 * independent avoids coupling two different concerns (real station
 * collection vs. regular-interval sampling) through one shared return shape.
 */

import { useState, useEffect } from 'react'
import type { RouteWaypoint } from '../utils/routeCalc'
import { TILES_BASE_URL, API_BASE_URL } from '../utils/env'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import { regularIntervalDistances, coordinateAlongRouteNm } from '@open-vfr/shared/virtualRadarCalc'
import {
  fetchWxResolvedForPoint, decodeMetar, parseMetarWind,
  type WxStationCandidate, type ParsedWind,
} from '@open-vfr/shared/fetchWx'

const SAMPLE_INTERVAL_NM = 15 // spacing between regular-interval samples
const MAX_SAMPLES        = 6  // hard cap regardless of route length
const SEARCH_CANDIDATES  = 6  // same default as fetchWxResolvedForPoint

export interface WindSample {
  distNm: number
  wind:   ParsedWind
  /** True when `wind` came from Open-Meteo's model forecast rather than a
   *  real METAR — callers should render this visibly differently (e.g.
   *  dashed/lighter) so it's never mistaken for an observed reading. */
  isModel:    boolean
  /** ICAO the wind came from; null when it's model wind with no real
   *  station involved at all. */
  sourceIcao: string | null
}

interface AerodromeRecord { icao: string; name: string; lat: number; lng: number }

export function useWindAlongRoute(waypoints: RouteWaypoint[], totalNm: number): WindSample[] {
  const [aerodromes, setAerodromes] = useState<AerodromeRecord[]>([])
  const [samples, setSamples] = useState<WindSample[]>([])

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
    if (waypoints.length < 2 || aerodromes.length === 0 || totalNm <= 0) { setSamples([]); return }

    const distances = regularIntervalDistances(totalNm, SAMPLE_INTERVAL_NM, MAX_SAMPLES)
    if (distances.length === 0) { setSamples([]); return }

    let cancelled = false
    const ac = new AbortController()

    Promise.all(distances.map(async (distNm): Promise<WindSample | null> => {
      const pos = coordinateAlongRouteNm(waypoints, distNm)
      // Candidates ranked by great-circle distance from THIS sample point,
      // not route-relative — the search is "nearest real station to here",
      // same as any other point-based lookup.
      const nearby: WxStationCandidate[] = aerodromes
        .map((a) => ({ icao: a.icao, distNm: distanceNm(pos, a) }))
        .sort((x, y) => x.distNm - y.distNm)

      try {
        const wx = await fetchWxResolvedForPoint(pos.lat, pos.lng, nearby, API_BASE_URL, ac.signal, undefined, SEARCH_CANDIDATES)

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
    })).then((results) => { if (!cancelled) setSamples(results.filter((s): s is WindSample => s != null)) })

    return () => { cancelled = true; ac.abort() }
  }, [waypoints, aerodromes, totalNm])

  return samples
}
