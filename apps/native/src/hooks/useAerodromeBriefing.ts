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
import { fetchNotams, type NotamItem } from '@open-vfr/shared/fetchNotam'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import { loadStations, type StationRecord } from '@open-vfr/shared/wxStations'
import { API_BASE, getTileUrls } from '../config'
import { authHeaders } from '../utils/authClient'

// Fallback search radius -- same as AerodromePopup's, wide enough to reach a
// towered/AWOS-equipped aerodrome from a small grass strip.
const WX_FALLBACK_MAX_NM = 100

export interface AerodromeBriefing {
  wx:           WxResolved | null
  wxLoading:    boolean
  /** Human name of the fallback station (wx.sourceIcao), when different from the requested icao. */
  wxSourceName: string | null
  notams:       NotamItem[]
  notamLoading: boolean
}

export function useAerodromeBriefing(icao: string | null, lat?: number, lng?: number): AerodromeBriefing {
  const [wx, setWx] = useState<WxResolved | null>(null)
  const [wxLoading, setWxLoading] = useState(true)
  const [wxSourceName, setWxSourceName] = useState<string | null>(null)
  const [notams, setNotams] = useState<NotamItem[]>([])
  const [notamLoading, setNotamLoading] = useState(true)

  useEffect(() => {
    if (!icao) return
    const ac = new AbortController()
    setWx(null); setWxLoading(true); setWxSourceName(null)
    setNotams([]); setNotamLoading(true)

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
        // No coordinates -- can't do a nearest-station search or model-wind
        // fallback, just fetch the aerodrome's own report.
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

  return { wx, wxLoading, wxSourceName, notams, notamLoading }
}
