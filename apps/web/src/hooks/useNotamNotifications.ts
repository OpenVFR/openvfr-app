/**
 * useNotamNotifications — silent entry/exit toasts for regional NOTAM circles.
 *
 * Mirrors useAirspaceNotifications.ts exactly, but for NOTAM circles instead
 * of se-airspace.geojson polygons. See useNotamWarnings.ts for why this
 * takes regionalNotams as a parameter rather than fetching independently.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { GpsPosition } from '../utils/gpsTypes'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import { notamTitle } from '@open-vfr/shared/notamQCode'
import { distanceNm } from '@open-vfr/shared/routeCalc'

const NOTIFICATION_TTL_MS = 9_000
const MAX_QUEUE           = 8

export type NotamNotificationDirection = 'entered' | 'left'

export type NotamNotification = {
  id:        string
  notamId:   string
  text:      string
  direction: NotamNotificationDirection
  expiresAt: number
}

export function useNotamNotifications(
  position: GpsPosition | null,
  regionalNotams: NotamItem[],
): {
  notifications: NotamNotification[]
  clearAll:      () => void
} {
  const [notifications, setNotifications] = useState<NotamNotification[]>([])
  const insideRef       = useRef<Set<string>>(new Set())
  const initializedRef  = useRef(false)

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      setNotifications(prev => prev.filter(n => n.expiresAt > now))
    }, 1_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!position || regionalNotams.length === 0) return

    const { lat, lng } = position
    const now = Date.now()

    // Tracked by nmsId (NMS-API's own globally-unique internal id), not the
    // display id -- confirmed live that different issuing authorities reuse
    // the same published NOTAM number (a German and an unrelated Italian
    // NOTAM both "M3011/26"), so tracking by display id risks conflating
    // two unrelated NOTAMs' entry/exit state and showing the wrong text.
    const current = new Set<string>()
    for (const n of regionalNotams) {
      if (n.lat === null || n.lon === null || n.radiusNm === null || n.radiusNm <= 0) continue
      if (distanceNm({ lat, lng }, { lat: n.lat, lng: n.lon }) <= n.radiusNm) current.add(n.nmsId)
    }

    const prev = insideRef.current

    if (!initializedRef.current) {
      insideRef.current     = current
      initializedRef.current = true
      return
    }

    const fresh: NotamNotification[] = []

    for (const id of current) {
      if (!prev.has(id)) {
        const n = regionalNotams.find(x => x.nmsId === id)
        if (!n) continue
        fresh.push({ id: `${id}::${now}::entered`, notamId: notamTitle(n), text: n.text, direction: 'entered', expiresAt: now + NOTIFICATION_TTL_MS })
      }
    }
    for (const id of prev) {
      if (!current.has(id)) {
        const n = regionalNotams.find(x => x.nmsId === id)
        fresh.push({ id: `${id}::${now}::left`, notamId: n ? notamTitle(n) : '', text: n?.text ?? '', direction: 'left', expiresAt: now + NOTIFICATION_TTL_MS })
      }
    }

    insideRef.current = current

    if (fresh.length > 0) {
      setNotifications(prev => [...fresh, ...prev].slice(0, MAX_QUEUE))
    }
  }, [position, regionalNotams])

  useEffect(() => {
    if (!position) {
      insideRef.current     = new Set()
      initializedRef.current = false
      setNotifications([])
    }
  }, [position])

  const clearAll = useCallback(() => setNotifications([]), [])

  return { notifications, clearAll }
}
