/**
 * useWindAloftAlongRoute (native) — mirrors apps/web/src/hooks/useWindAloftAlongRoute.ts.
 * Winds at several flight levels along the route, drawn by VerticalProfile.
 */

import { useEffect, useState } from 'react'
import type { RouteWaypoint } from '@open-vfr/shared/types'
import { fetchWindAloftAlongRoute, type WindAloftColumn } from '@open-vfr/shared/windAloft'
import { API_BASE } from '../config'

const DEBOUNCE_MS = 400

export function useWindAloftAlongRoute(
  waypoints: RouteWaypoint[],
  totalNm: number,
  maxAltFt: number,
): WindAloftColumn[] {
  const [columns, setColumns] = useState<WindAloftColumn[]>([])
  // Keyed on coordinates, not array identity, so a re-render with an equal route doesn't refetch.
  const routeKey = waypoints.map((w) => `${w.lat.toFixed(3)},${w.lng.toFixed(3)}`).join('|')

  useEffect(() => {
    if (waypoints.length < 2 || totalNm <= 0) { setColumns([]); return }
    const ac = new AbortController()
    const timer = setTimeout(() => {
      fetchWindAloftAlongRoute(waypoints, totalNm, maxAltFt, API_BASE, ac.signal)
        .then((c) => { if (!ac.signal.aborted) setColumns(c) })
        .catch(() => { /* offline-safe: no barbs */ })
    }, DEBOUNCE_MS)
    return () => { clearTimeout(timer); ac.abort() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, totalNm, maxAltFt])

  return columns
}
