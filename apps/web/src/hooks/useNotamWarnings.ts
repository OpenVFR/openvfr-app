/**
 * useNotamWarnings — proactive penetration alerts for regional NOTAM circles.
 *
 * Mirrors useAirspaceWarnings.ts's design exactly, but for the ad-hoc
 * circles built from each FIR-wide NOTAM's own coordinates+radius (see
 * useRegionalNotams.ts) instead of se-airspace.geojson polygons:
 *   1. Checks if the aircraft is currently INSIDE any NOTAM circle
 *      (distance from centre <= radius).
 *   2. Projects the aircraft forward by lookaheadMin minutes and samples
 *      points along that path, same rationale as useAirspaceWarnings
 *      (catches narrow/small circles the endpoint alone would miss).
 *
 * Simplification vs. useAirspaceWarnings: no vertical-closure logic. NMS-API
 * NOTAM records do carry minimumFl/maximumFl, but apps/api/src/notam.ts does
 * not currently capture them on NotamItem (only lat/lon/radiusNm) -- treat
 * every NOTAM circle as relevant at any altitude for now (reasonable default
 * for restricted/danger areas, which are usually SFC-unlimited anyway; a
 * genuinely altitude-limited NOTAM would currently over-warn rather than
 * silently under-warn, the safer direction to be wrong in). Revisit if
 * minimumFl/maximumFl get captured server-side later.
 *
 * Takes the already-fetched regional NOTAMs as input (from
 * useRegionalNotams()) rather than fetching independently -- that hook
 * already polls the live, session-gated /api/notam/regional endpoint;
 * duplicating the fetch here would just double the request rate for no
 * benefit, unlike useAirspaceWarnings's static-file fetch (cheap, cached).
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { GpsPosition } from '../utils/gpsTypes'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import { notamTitle } from '@open-vfr/shared/notamQCode'
import { distanceNm, advancePosition } from '@open-vfr/shared/routeCalc'

const LOOKAHEAD_MIN_SPEED = 60
const LOOKAHEAD_SAMPLES   = 5
const DISMISS_REARM_MS    = 5 * 60_000
export const DEFAULT_NOTAM_LOOKAHEAD_MIN = 5

export type NotamAlert = {
  /** Stable identifier: NOTAM's nmsId, NOT its display id (used as React
   *  key + dismiss token) -- different issuing authorities reuse the same
   *  published NOTAM number, confirmed live (a German and an unrelated
   *  Italian NOTAM both published as "M3011/26"), so the display id alone
   *  isn't unique enough for dismiss-state tracking. */
  key:      string
  notamId:  string
  text:     string
  radiusNm: number
  /** True = aircraft is currently inside; false = lookahead penetration. */
  inside:   boolean
}

export function useNotamWarnings(
  position: GpsPosition | null,
  regionalNotams: NotamItem[],
  lookaheadMin: number = DEFAULT_NOTAM_LOOKAHEAD_MIN,
): {
  alerts:  NotamAlert[]
  dismiss: (key: string) => void
} {
  const [alerts, setAlerts] = useState<NotamAlert[]>([])
  const dismissedRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    if (!position || regionalNotams.length === 0) {
      setAlerts([])
      return
    }

    const { lat, lng, speedKts, trackDeg } = position
    const now = Date.now()

    const speedForLook = Math.max(speedKts, LOOKAHEAD_MIN_SPEED)
    const lookDistNm   = (lookaheadMin / 60) * speedForLook
    const aheadSamples = Array.from({ length: LOOKAHEAD_SAMPLES }, (_, i) =>
      advancePosition(lat, lng, trackDeg, lookDistNm * ((i + 1) / LOOKAHEAD_SAMPLES)),
    )

    const found: NotamAlert[] = []

    for (const n of regionalNotams) {
      if (n.lat === null || n.lon === null || n.radiusNm === null || n.radiusNm <= 0) continue

      const key = n.nmsId
      const dismissedAt = dismissedRef.current.get(key)
      if (dismissedAt !== undefined && now - dismissedAt < DISMISS_REARM_MS) continue

      const center = { lat: n.lat, lng: n.lon }
      const insideCurrent = distanceNm({ lat, lng }, center) <= n.radiusNm
      const insideAhead   = !insideCurrent &&
        aheadSamples.some(p => distanceNm(p, center) <= n.radiusNm!)

      if (insideCurrent || insideAhead) {
        found.push({
          key,
          notamId:  notamTitle(n),
          text:     n.text,
          radiusNm: n.radiusNm,
          inside:   insideCurrent,
        })
      }
    }

    // Inside-now first, matching useAirspaceWarnings's sort priority.
    found.sort((a, b) => (a.inside === b.inside ? 0 : a.inside ? -1 : 1))
    setAlerts(found)
  }, [position, regionalNotams, lookaheadMin])

  const dismiss = useCallback((key: string) => {
    dismissedRef.current.set(key, Date.now())
    setAlerts(prev => prev.filter(a => a.key !== key))
  }, [])

  return { alerts, dismiss }
}
