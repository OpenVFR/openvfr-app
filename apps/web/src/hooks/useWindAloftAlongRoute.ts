/**
 * useWindAloftAlongRoute — winds at several flight levels at regular
 * intervals along a route, drawn by VirtualRadar as barbs at their altitude.
 * One multi-level request per route (see @open-vfr/shared/windAloft); results
 * land in fetchWind's cache so repeated route edits stay cheap.
 */

import { useEffect, useState } from 'react'
import type { RouteWaypoint } from '../utils/routeCalc'
import { API_BASE_URL } from '../utils/env'
import { fetchWindAloftAlongRoute, type WindAloftColumn } from '@open-vfr/shared/windAloft'

const DEBOUNCE_MS = 400

export function useWindAloftAlongRoute(
  waypoints: RouteWaypoint[],
  totalNm: number,
  maxAltFt: number,
  enabled: boolean,
): WindAloftColumn[] {
  const [columns, setColumns] = useState<WindAloftColumn[]>([])
  // Keyed on coordinates, not array identity, so a re-render with an equal route doesn't refetch.
  const routeKey = waypoints.map((w) => `${w.lat.toFixed(3)},${w.lng.toFixed(3)}`).join('|')

  useEffect(() => {
    if (!enabled || waypoints.length < 2 || totalNm <= 0) { setColumns([]); return }
    const ac = new AbortController()
    const timer = setTimeout(() => {
      // Chart x-axis ticks sit at ~totalNm/7 steps; keep ground barbs off their labels.
      fetchWindAloftAlongRoute(waypoints, totalNm, maxAltFt, API_BASE_URL, ac.signal, Math.ceil(totalNm) / 7)
        .then((c) => { if (!ac.signal.aborted) setColumns(c) })
        .catch(() => { /* offline-safe: no barbs */ })
    }, DEBOUNCE_MS)
    return () => { clearTimeout(timer); ac.abort() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, totalNm, maxAltFt, enabled])

  return columns
}
