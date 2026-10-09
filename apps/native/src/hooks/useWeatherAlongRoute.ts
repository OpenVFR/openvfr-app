/**
 * useWeatherAlongRoute (native) — mirrors apps/web/src/hooks/useWeatherAlongRoute.ts,
 * using native's bearer-token auth (authHeaders()) instead of the browser's
 * cookie-based credentials. The MAX_STATIONS cap is applied per along-route
 * bucket (not a flat global sort by lateral distance) so a cluster of
 * aerodromes near one leg can't evict coverage near the route's start/end
 * on a long route -- see the bucketing comment below.
 */

import { useState, useEffect } from 'react'
import type { RouteWaypoint } from '@open-vfr/shared/types'
import { distanceToRouteNm } from '@open-vfr/shared/notamRouteFilter'
import { distanceAlongRouteNm } from '@open-vfr/shared/virtualRadarCalc'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import { fetchWxNearest, decodeMetar, type MetarDecoded, type WxStationCandidate } from '@open-vfr/shared/fetchWx'
import { API_BASE, getTileUrls } from '../config'
import { authHeaders } from '../utils/authClient'

const BUFFER_NM    = 15
const MAX_STATIONS = 12

// Short-lived per-ICAO weather cache shared by every hook instance (map screen,
// plan screen, ruler): they fetch the same stations for the same route, and
// each used to hit /api/weather on its own. Failed fetches are not kept.
const WX_TTL_MS = 60_000
const wxCache = new Map<string, { at: number; p: Promise<Awaited<ReturnType<typeof fetchWxNearest>>> }>()
function cachedWx(icao: string, load: () => ReturnType<typeof fetchWxNearest>) {
  const hit = wxCache.get(icao)
  if (hit && Date.now() - hit.at < WX_TTL_MS) return hit.p
  const p = load()
  wxCache.set(icao, { at: Date.now(), p })
  p.catch(() => { if (wxCache.get(icao)?.p === p) wxCache.delete(icao) })
  return p
}

export interface RouteWeatherStation {
  icao:    string
  name:    string
  distNm:  number
  /** Station coordinates — carried through so callers that need the
   *  along-route (not just lateral) distance, e.g. VerticalProfile placing
   *  wind/cloud markers on its distance axis, can project it themselves via
   *  distanceAlongRouteNm without a second round trip. */
  lat:     number
  lng:     number
  metar:   string | null
  taf:     string | null
  decoded: MetarDecoded | null
  /** ICAO the metar/taf actually came from -- equals `icao` unless this
   *  aerodrome has no own report and fetchWxNearest substituted the
   *  closest reporting neighbor. Mirrors web's identical addition. */
  sourceIcao: string
  /** Great-circle NM from this aerodrome to `sourceIcao`, or null when the
   *  aerodrome's own report was used. Used only to pick the best
   *  representative when de-duping fallback groups -- mirrors web. */
  sourceDistNm: number | null
}

interface AerodromeRecord { icao: string; name: string; lat: number; lng: number }

// Module-level cache of the parsed aerodrome list, keyed by URL, shared by
// every hook instance -- MapScreen runs this hook twice (planned route +
// Map Ruler line), and the nationwide aerodromes GeoJSON shouldn't be
// fetched and parsed once per instance on a memory-constrained device.
// Cleared on failure so a later mount can retry after a connectivity gap.
let aerodromesCache: { url: string; promise: Promise<AerodromeRecord[]> } | null = null

function loadAerodromes(url: string): Promise<AerodromeRecord[]> {
  if (aerodromesCache?.url === url) return aerodromesCache.promise
  const promise = fetch(url)
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
      return arr
    })
  promise.catch(() => { if (aerodromesCache?.promise === promise) aerodromesCache = null })
  aerodromesCache = { url, promise }
  return promise
}

// `enabled` defaults true (matches every existing call site) -- MapScreen
// passes mapReady here so this hook's own aerodromes.json fetch doesn't fire
// in the same first-mount burst as the basemap's PMTiles loads (see
// HANDOFF_oom_investigation.md next-steps #1). The per-station wx fetches
// below are already naturally gated behind `waypoints.length > 0`, which is
// rarely true at cold start, but the top-level aerodromes fetch was not.
export function useWeatherAlongRoute(waypoints: RouteWaypoint[], enabled = true): RouteWeatherStation[] {
  const [aerodromes, setAerodromes] = useState<AerodromeRecord[]>([])
  const [stations, setStations] = useState<RouteWeatherStation[]>([])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    loadAerodromes(getTileUrls().aerodromes)
      .then((arr) => { if (!cancelled) setAerodromes(arr) })
      .catch(() => { /* offline-safe */ })
    return () => { cancelled = true }
  }, [enabled])

  useEffect(() => {
    if (!enabled || waypoints.length === 0 || aerodromes.length === 0) { setStations([]); return }

    // distNm here is LATERAL (cross-track) distance to the route -- kept
    // as-is, other callers (WeatherAlongRouteSheet etc.) display it as
    // "distance from route". alongNm (along-route position) is only used
    // below to pick which candidates survive the MAX_STATIONS cap; it is
    // NOT carried into the returned station shape. Mirrors web's identical
    // fix in apps/web/src/hooks/useWeatherAlongRoute.ts.
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
    // chart. Bucket by along-route position instead so coverage stays spread
    // across the route: divide [0,totalNm] into MAX_STATIONS segments, keep
    // only the laterally-nearest candidate per segment.
    const totalNm = waypoints.length >= 2
      ? distanceAlongRouteNm(waypoints, waypoints[waypoints.length - 1])
      : 0
    // Both branches sort by alongNm (along-route position, flight sequence)
    // -- the cap-selection logic below still uses lateral distNm ("pick the
    // laterally-nearest per bucket/overall"), but the final order shown to
    // the pilot is always departure -> destination, never "nearest first"
    // (previously this short-route branch diverged from the bucketed one
    // below and sorted by lateral distance instead, inconsistently -- see
    // web's identical fix in its own useWeatherAlongRoute.ts).
    let nearby: typeof candidates
    if (candidates.length <= MAX_STATIONS || totalNm <= 0) {
      nearby = candidates.sort((a, b) => a.alongNm - b.alongNm).slice(0, MAX_STATIONS)
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

    // Small/uncontrolled aerodromes rarely have their own AWOS/ATIS --
    // substitute the closest OTHER aerodrome's real report instead of
    // leaving a candidate with no data (mirrors web's identical fix, and
    // AerodromePopup's existing use of the same fetchWxNearest fallback).
    const otherCandidatesFor = (station: AerodromeRecord): WxStationCandidate[] =>
      aerodromes
        .filter((other) => other.icao !== station.icao)
        .map((other) => ({ icao: other.icao, distNm: distanceNm(station, other) }))
        .sort((x, y) => x.distNm - y.distNm)

    async function run() {
      const headers = await authHeaders()
      const results = await Promise.all(nearby.map(async (a): Promise<RouteWeatherStation> => {
        try {
          const wx = await cachedWx(a.icao, () => fetchWxNearest(a.icao, otherCandidatesFor(a), API_BASE, undefined, headers))
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
      }))
      if (cancelled) return
      // De-dupe fallback groups -- several report-less aerodromes can all
      // resolve to the SAME distant real station; keep one entry per
      // distinct sourceIcao (prefer the real station itself, else the
      // closest group member to it). Mirrors web's identical de-dupe.
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
    }
    void run()

    return () => { cancelled = true }
  }, [waypoints, aerodromes, enabled])

  return stations
}
