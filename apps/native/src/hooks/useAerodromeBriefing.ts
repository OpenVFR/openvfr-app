/**
 * useAerodromeBriefing — fetches METAR/TAF (with nearest-station fallback)
 * and active NOTAMs for a single aerodrome.
 *
 * Extracted from AerodromePopup.tsx so the same wx+NOTAM fetch (and its
 * loading/error/source-station bookkeeping) can be reused by any other
 * surface that needs "this aerodrome's weather + NOTAMs" without an
 * aerodrome tap — e.g. VicinityBriefSheet.tsx's picker-driven Wx/NOTAM tabs.
 * Logic is unchanged from the original effect, just lifted out of the
 * component and parameterised.
 */

import { useEffect, useState } from 'react'
import {
  fetchWxResolved, type WxResolved, type WxStationCandidate,
} from '@open-vfr/shared/fetchWx'
import { fetchAmbientWx, type AmbientWx } from '@open-vfr/shared/fetchWind'
import { fetchNotams, type NotamItem } from '@open-vfr/shared/fetchNotam'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import { loadStations, type StationRecord } from '@open-vfr/shared/wxStations'
import { API_BASE, getTileUrls } from '../config'
import { authHeaders } from '../utils/authClient'

// Fallback search radius -- same as AerodromePopup's, wide enough to reach a
// towered/AWOS-equipped aerodrome from a small grass strip.
const WX_FALLBACK_MAX_NM = 100

export interface AerodromeBriefing {
  /** METAR/TAF, own icao auto-falling back to the nearest reporting
   *  station -- null while loading. */
  wx:           WxResolved | null
  wxLoading:    boolean
  /** Human name of the fallback station (wx.sourceIcao), when different
   *  from the requested icao. */
  wxSourceName: string | null
  /** Open-Meteo ambient reading (wind/temp/cloud/pressure/precip) at this
   *  aerodrome's own coordinates -- always fetched regardless of METAR
   *  availability, so the Weather station tab is ready the instant it's
   *  selected. Null while loading, no coordinates, or on fetch failure. */
  ambientWx:    AmbientWx | null
  notams:       NotamItem[]
  notamLoading: boolean
}

export function useAerodromeBriefing(icao: string | null, lat?: number, lng?: number): AerodromeBriefing {
  const [wx, setWx] = useState<WxResolved | null>(null)
  const [wxLoading, setWxLoading] = useState(true)
  const [wxSourceName, setWxSourceName] = useState<string | null>(null)
  const [ambientWx, setAmbientWx] = useState<AmbientWx | null>(null)
  const [notams, setNotams] = useState<NotamItem[]>([])
  const [notamLoading, setNotamLoading] = useState(true)

  useEffect(() => {
    if (!icao) return
    const ac = new AbortController()
    setWx(null); setWxLoading(true); setWxSourceName(null); setAmbientWx(null)
    setNotams([]); setNotamLoading(true)

    // Weather station (Open-Meteo) tier -- proxied directly at the nginx
    // level (see AGENTS.md's Server API Security Baseline note), no auth
    // needed, fetched independently of the METAR/NOTAM auth-gated calls
    // below so it's ready the instant it's selected.
    if (lat != null && lng != null) {
      fetchAmbientWx(lat, lng, API_BASE, ac.signal)
        .then((data) => { if (!ac.signal.aborted) setAmbientWx(data) })
        .catch((err) => { if ((err as Error).name !== 'AbortError') { /* leave ambientWx null -- "no data" state */ } })
    }

    authHeaders().then((headers) => {
      const aerodromesUrl = getTileUrls().aerodromes
      const wxPromise = lat != null && lng != null
        ? loadStations(aerodromesUrl)
            .catch(() => [] as StationRecord[])
            .then((stations) => {
              const candidates: WxStationCandidate[] = stations
                .filter((s) => s.icao !== icao)
                .map((s) => ({ icao: s.icao, distNm: distanceNm({ lat, lng }, { lat: s.lat, lng: s.lng }) }))
                .filter((c) => c.distNm <= WX_FALLBACK_MAX_NM)
                .sort((a, b) => a.distNm - b.distNm)
              const nameByIcao = new Map(stations.map((s) => [s.icao, s.name]))
              return fetchWxResolved(icao, lat, lng, candidates, API_BASE, ac.signal, headers)
                .then((data) => {
                  setWx(data)
                  setWxSourceName(data.sourceIcao !== icao ? (nameByIcao.get(data.sourceIcao) ?? null) : null)
                })
            })
        // No coordinates -- can't do a nearest-station search, just fetch
        // the aerodrome's own report.
        : fetchWxResolved(icao, 0, 0, [], API_BASE, ac.signal, headers)
            .then((data) => { setWx(data) })

      wxPromise
        .catch((err) => { if ((err as Error).name !== 'AbortError') { /* leave wx null -- "no data" state */ } })
        .finally(() => setWxLoading(false))

      fetchNotams(icao, API_BASE, ac.signal, headers)
        .then((d) => { setNotams(d.notams); setNotamLoading(false) })
        .catch(() => setNotamLoading(false))
    })

    return () => ac.abort()
  }, [icao, lat, lng])

  return { wx, wxLoading, wxSourceName, ambientWx, notams, notamLoading }
}
