/**
 * useWeatherAlongRoute — collects METAR/TAF for aerodromes near the planned
 * route into one list, automatically refreshed as the route is plotted.
 * Complements per-airport weather already shown in AerodromePopup -- this
 * is the "along the whole route at a glance" view, same relationship as
 * RegionalNotamsPanel vs. per-airport NOTAM tab.
 *
 * Buffer is wider than the NOTAM route filter (15nm vs 5nm) -- METAR
 * stations are much sparser than NOTAM-affected areas, and pilots
 * reasonably care about weather at airports a bit further off-track than
 * NOTAMs strictly along the corridor. Station count capped (12) to avoid
 * firing a large parallel burst of /api/weather requests for a long route.
 * The cap is applied per along-route bucket (not a flat global sort by
 * lateral distance) so a cluster of aerodromes near one leg can't evict
 * coverage near the route's start/end on a long route -- see the bucketing
 * comment below.
 */

import { useState, useEffect } from 'react'
import type { RouteWaypoint } from '../utils/routeCalc'
import { TILES_BASE_URL, API_BASE_URL } from '../utils/env'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'
import { distanceToRouteNm } from '@open-vfr/shared/notamRouteFilter'
import { distanceAlongRouteNm } from '@open-vfr/shared/virtualRadarCalc'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import { fetchWxNearest, decodeMetar, type MetarDecoded, type WxStationCandidate } from '@open-vfr/shared/fetchWx'

const BUFFER_NM     = 15
const MAX_STATIONS  = 12

export interface RouteWeatherStation {
  icao:    string
  name:    string
  distNm:  number
  /** Station coordinates — carried through so callers needing the
   *  along-route (not just lateral) distance, e.g. VirtualRadar placing
   *  wind/cloud markers on its distance axis, can project it themselves via
   *  @open-vfr/shared/virtualRadarCalc's projectWeatherMarks. Mirrors
   *  native's identical addition to its own useWeatherAlongRoute. */
  lat:     number
  lng:     number
  metar:   string | null
  taf:     string | null
  decoded: MetarDecoded | null
  /** ICAO the metar/taf actually came from, when this aerodrome has no own
   *  report and fetchWxNearest substituted the closest reporting neighbor
   *  (small/uncontrolled fields rarely have their own AWOS/ATIS) -- equals
   *  `icao` when the aerodrome's own report was used directly. Lets a
   *  caller footnote "via ESxx" instead of silently implying a station has
   *  its own live wind observation when it doesn't. */
  sourceIcao: string
  /** Great-circle NM from this aerodrome to `sourceIcao`, or null when the
   *  aerodrome's own report was used (no substitution). Used only to pick
   *  the best representative when de-duping fallback groups below --
   *  not surfaced as a rendered value anywhere yet. */
  sourceDistNm: number | null
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

    // distNm here is LATERAL (cross-track) distance to the route -- kept
    // as-is, other callers (WeatherAlongRoutePanel etc.) display it as
    // "distance from route". alongNm (along-route position) is only used
    // below to pick which candidates survive the MAX_STATIONS cap; it is
    // NOT carried into the returned station shape.
    const candidates = aerodromes
      .map((a) => ({
        ...a,
        distNm:  distanceToRouteNm({ lat: a.lat, lng: a.lng }, waypoints),
        alongNm: distanceAlongRouteNm(waypoints, { lat: a.lat, lng: a.lng }),
      }))
      .filter((a) => a.distNm <= BUFFER_NM)

    // Cap used to be a flat global sort-by-lateral-distance + slice, which
    // ranks every candidate on the whole route against each other purely by
    // how close it sits to the line -- fine for a short route, but once a
    // route passes MAX_STATIONS nearby aerodromes (easy on a long route with
    // several airfields clustered near one leg), that cluster fills every
    // slot and silently evicts stations near the route's start/end even
    // though they're still within BUFFER_NM and still project fine onto the
    // chart (see projectWeatherMarks). Bucket by along-route position
    // instead so coverage stays spread across the route: divide [0,totalNm]
    // into MAX_STATIONS segments, keep only the laterally-nearest candidate
    // per segment.
    const totalNm = waypoints.length >= 2
      ? distanceAlongRouteNm(waypoints, waypoints[waypoints.length - 1])
      : 0
    let nearby: typeof candidates
    if (candidates.length <= MAX_STATIONS || totalNm <= 0) {
      nearby = candidates.sort((a, b) => a.distNm - b.distNm).slice(0, MAX_STATIONS)
    } else {
      const bucketSize = totalNm / MAX_STATIONS
      const bestPerBucket = new Map<number, typeof candidates[number]>()
      for (const c of candidates) {
        const bucket = Math.min(MAX_STATIONS - 1, Math.floor(c.alongNm / bucketSize))
        const existing = bestPerBucket.get(bucket)
        if (!existing || c.distNm < existing.distNm) bestPerBucket.set(bucket, c)
      }
      nearby = Array.from(bestPerBucket.values()).sort((a, b) => a.alongNm - b.alongNm)
    }

    let cancelled = false
    const ac = new AbortController()

    // Small/uncontrolled aerodromes rarely have their own AWOS/ATIS -- a
    // station in `nearby` with no own METAR/TAF previously just showed no
    // wind arrow at all, even when it happens to be the route's departure
    // or destination. fetchWxNearest (same fallback AerodromePopup already
    // uses) substitutes the closest OTHER aerodrome's real report instead
    // of leaving it blank. Built per-candidate (great-circle distance from
    // THAT aerodrome, not route-relative) since the fallback search is
    // "nearest to the airport with no report", independent of the route.
    const otherCandidatesFor = (station: AerodromeRecord): WxStationCandidate[] =>
      aerodromes
        .filter((other) => other.icao !== station.icao)
        .map((other) => ({ icao: other.icao, distNm: distanceNm(station, other) }))
        .sort((x, y) => x.distNm - y.distNm)

    Promise.all(nearby.map(async (a): Promise<RouteWeatherStation> => {
      try {
        const wx = await fetchWxNearest(a.icao, otherCandidatesFor(a), API_BASE_URL, ac.signal)
        return {
          icao: a.icao, name: a.name, distNm: Math.round(a.distNm * 10) / 10,
          lat: a.lat, lng: a.lng,
          metar: wx.metar, taf: wx.taf,
          decoded: wx.metar ? decodeMetar(wx.metar) : null,
          sourceIcao: wx.sourceIcao, sourceDistNm: wx.distNm,
        }
      } catch {
        return { icao: a.icao, name: a.name, distNm: Math.round(a.distNm * 10) / 10, lat: a.lat, lng: a.lng, metar: null, taf: null, decoded: null, sourceIcao: a.icao, sourceDistNm: null }
      }
    })).then((results) => {
      if (cancelled) return
      // De-dupe fallback groups: several nearby-but-report-less aerodromes
      // can all resolve to the SAME distant real station (see fetchWxNearest
      // above), which without this would draw one wind arrow/cloud layer PER
      // aerodrome instead of once for the underlying observation -- e.g. 4-5
      // small strips clustered near an airport with a real METAR all render
      // as duplicate copies of that one reading. Keep exactly one entry per
      // distinct sourceIcao: prefer the entry that IS that real station
      // (icao === sourceIcao, i.e. not itself a substitution) when present in
      // the group, else the group member geographically closest to the real
      // source (smallest sourceDistNm).
      const bySource = new Map<string, RouteWeatherStation[]>()
      for (const r of results) {
        const group = bySource.get(r.sourceIcao)
        if (group) group.push(r); else bySource.set(r.sourceIcao, [r])
      }
      const deduped = Array.from(bySource.values()).map((group) => {
        if (group.length === 1) return group[0]
        return group.find((g) => g.icao === g.sourceIcao)
          ?? group.reduce((best, g) => (g.sourceDistNm ?? Infinity) < (best.sourceDistNm ?? Infinity) ? g : best)
      })
      setStations(deduped)
    })

    return () => { cancelled = true; ac.abort() }
  }, [waypoints, aerodromes])

  return stations
}
