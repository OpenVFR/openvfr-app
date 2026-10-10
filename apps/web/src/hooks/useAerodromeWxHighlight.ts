/**
 * useAerodromeWxHighlight — geofenced, automatic "favoured runway end"
 * highlight for the map's own 'runway-threshold-label' layer, without
 * requiring the pilot to open that aerodrome's popup first.
 *
 * Distinct from useAirfieldBrief (which drives the always-visible
 * AirfieldBriefPanel strip) -- this uses a deliberately LARGER trigger
 * radius (WX_TRIGGER_NM / WX_DEST_TRIGGER_NM below), since "start showing
 * me which runway to plan for" is useful earlier than "you're now close
 * enough that the frequency/PPR panel should appear". Same underlying
 * nearest-aerodrome-or-route-destination matching approach as
 * useAirfieldBrief, reusing its exact cached aerodrome loader (see that
 * file's loadAerodromes() export) rather than adding another GeoJSON fetch.
 *
 * One fetch per newly-qualifying aerodrome, with a single retry on failure
 * (not a continuous refresh loop -- METAR conditions changing mid-flight
 * past this aerodrome, or after a manual re-open of its popup, is an
 * accepted staleness tradeoff for a passive convenience overlay). Successful
 * results are cached per-ICAO for the lifetime of the map session so
 * re-approaching the same aerodrome, or handing control back from an
 * AerodromePopup that was open over it, re-asserts instantly without a
 * redundant network round-trip.
 */

import { useEffect, useRef, useState } from 'react'
import type { GpsPosition } from '../utils/gpsTypes'
import type { RouteWaypoint } from '../utils/routeCalc'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import { computeRunwayWind, type RunwayWindEnd } from '@open-vfr/shared/runwayWind'
import { fetchWxResolved, decodeMetar, parseMetarWind, type ParsedWind } from '../utils/fetchWx'
import { API_BASE_URL } from '../utils/env'
import { loadAerodromes, type FullAerodrome } from './useAirfieldBrief'
import { useActiveCountries } from '../utils/countryData'

// ── Constants ─────────────────────────────────────────────────────────────────
// Deliberately larger than useAirfieldBrief's BRIEF_DIST_NM/DEST_DIST_NM
// (3/8 NM) -- a runway/wind highlight is useful with enough lead time to
// actually plan the approach, not just once you're basically in the
// pattern. ~15/25 NM gives roughly 8-15 minutes' notice at typical GA
// cruise speeds. Heuristic, not a hard standard -- tune freely.
const WX_TRIGGER_NM      = 15   // nearest unplanned aerodrome
const WX_DEST_TRIGGER_NM = 25   // route destination
const ROUTE_MATCH_NM     = 0.5  // aerodrome is "the destination" if within this of the active waypoint
const RETRY_DELAY_MS     = 5000
const WX_FALLBACK_MAX_NM = 100  // same station-fallback search radius as AerodromePopup

export interface AerodromeWxHighlight {
  icao: string
  ends: RunwayWindEnd[]
}

export function useAerodromeWxHighlight(
  position:       GpsPosition | null,
  routeWaypoints: RouteWaypoint[],
  activeWpIdx:    number,
  /** False while an AerodromePopup is open -- its own fetch/onRunwayWind
   *  effect is the sole driver of the shared map highlight state then, to
   *  avoid two independent effects racing to write the same value. */
  enabled: boolean,
): AerodromeWxHighlight | null {
  const [aerodromes, setAerodromes] = useState<FullAerodrome[]>([])
  const [highlight, setHighlight]   = useState<AerodromeWxHighlight | null>(null)
  const [targetIcao, setTargetIcao] = useState<string | null>(null)
  const targetRef      = useRef<FullAerodrome | null>(null)
  const cacheRef        = useRef<Map<string, RunwayWindEnd[]>>(new Map())
  const inFlightIcaoRef = useRef<string | null>(null)

  // Load aerodrome data once (shared cache with useAirfieldBrief).
  const { key: countriesKey } = useActiveCountries()
  useEffect(() => {
    loadAerodromes().then((arr) => { if (arr.length > 0) setAerodromes(arr) })
  }, [countriesKey])

  // Which aerodrome currently qualifies -- same nearest/destination pattern
  // as useAirfieldBrief, just with a bigger radius.
  useEffect(() => {
    if (!position || aerodromes.length === 0) {
      targetRef.current = null
      setTargetIcao(null)
      return
    }
    const { lat, lng } = position

    const activeWp = routeWaypoints[activeWpIdx]
    let destAerodrome: FullAerodrome | null = null
    if (activeWp) {
      const destDist = distanceNm({ lat, lng }, { lat: activeWp.lat, lng: activeWp.lng })
      if (destDist <= WX_DEST_TRIGGER_NM) {
        let best: FullAerodrome | null = null
        let bestDist = ROUTE_MATCH_NM
        for (const ad of aerodromes) {
          const d = distanceNm({ lat: activeWp.lat, lng: activeWp.lng }, { lat: ad.lat, lng: ad.lng })
          if (d <= bestDist) { bestDist = d; best = ad }
        }
        if (best) destAerodrome = best
      }
    }

    let nearest: FullAerodrome | null = null
    let nearestDist = WX_TRIGGER_NM
    for (const ad of aerodromes) {
      const d = distanceNm({ lat, lng }, { lat: ad.lat, lng: ad.lng })
      if (d <= nearestDist) { nearestDist = d; nearest = ad }
    }

    const chosen = destAerodrome ?? nearest
    targetRef.current = chosen
    setTargetIcao(chosen ? (chosen.props.icao || chosen.key) : null)
  }, [position, aerodromes, routeWaypoints, activeWpIdx])

  // Fetch (or re-assert from cache) whenever the qualifying aerodrome
  // changes, or `enabled` flips true (e.g. an AerodromePopup that was
  // covering this same aerodrome just closed).
  useEffect(() => {
    if (!enabled) return
    if (!targetIcao) { setHighlight(null); return }

    const cached = cacheRef.current.get(targetIcao)
    if (cached) { setHighlight({ icao: targetIcao, ends: cached }); return }

    const ad = targetRef.current
    if (!ad || inFlightIcaoRef.current === targetIcao) return
    inFlightIcaoRef.current = targetIcao

    const ac = new AbortController()
    const candidates = aerodromes
      .filter((a) => (a.props.icao || a.key) !== targetIcao && a.props.icao)
      .map((a) => ({ icao: a.props.icao, distNm: distanceNm({ lat: ad.lat, lng: ad.lng }, { lat: a.lat, lng: a.lng }) }))
      .filter((c) => c.distNm <= WX_FALLBACK_MAX_NM)
      .sort((a, b) => a.distNm - b.distNm)

    async function attempt(retriesLeft: number): Promise<void> {
      try {
        const wx = await fetchWxResolved(targetIcao!, ad!.lat, ad!.lng, candidates, API_BASE_URL, ac.signal)
        if (ac.signal.aborted) return
        const metar = wx.metar ? decodeMetar(wx.metar) : null
        const surfaceWind = metar ? parseMetarWind(metar.wind) : null
        const modelWind: ParsedWind | null = wx.modelWind
          ? { dirDeg: wx.modelWind.dirDeg, speedKt: wx.modelWind.speedKts, gustKt: null, variable: false, calm: wx.modelWind.speedKts === 0 }
          : null
        const effectiveWind = modelWind ?? surfaceWind
        const ends = ad!.props.runways
          .flatMap((rwy) => computeRunwayWind(rwy.thresholds, effectiveWind))
          .filter((e) => e.headwindKt != null)

        cacheRef.current.set(targetIcao!, ends)
        inFlightIcaoRef.current = null
        setHighlight(ends.length > 0 ? { icao: targetIcao!, ends } : null)
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        inFlightIcaoRef.current = null
        if (retriesLeft > 0) {
          setTimeout(() => { if (!ac.signal.aborted) attempt(retriesLeft - 1) }, RETRY_DELAY_MS)
        } else {
          console.warn('[useAerodromeWxHighlight] weather fetch failed for', targetIcao, err)
        }
      }
    }
    attempt(1) // one retry, per product decision -- not a continuous refresh loop

    return () => { ac.abort(); if (inFlightIcaoRef.current === targetIcao) inFlightIcaoRef.current = null }
  }, [targetIcao, enabled, aerodromes])

  return highlight
}
