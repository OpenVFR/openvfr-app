/**
 * useWindAloftAlongRoute (native) — mirrors apps/web/src/hooks/useWindAloftAlongRoute.ts.
 * Winds at several flight levels along the route, drawn by VerticalProfile.
 */

import { useEffect, useState } from 'react'
import type { RouteWaypoint } from '@open-vfr/shared/types'
import { watchWindAloftAlongRoute, type WindAloftColumn, type WindAloftStatus } from '@open-vfr/shared/windAloft'
import { API_BASE } from '../config'

const DEBOUNCE_MS = 400

export function useWindAloftAlongRoute(
  waypoints: RouteWaypoint[],
  totalNm: number,
  maxAltFt: number,
  enabled = true,
): { columns: WindAloftColumn[]; status: WindAloftStatus } {
  const [state, setState] = useState<{ columns: WindAloftColumn[]; status: WindAloftStatus }>({ columns: [], status: 'ok' })
  // Keyed on coordinates, not array identity, so a re-render with an equal route doesn't refetch.
  const routeKey = waypoints.map((w) => `${w.lat.toFixed(3)},${w.lng.toFixed(3)}`).join('|')

  useEffect(() => {
    if (!enabled || waypoints.length < 2 || totalNm <= 0) { setState((prev) => (prev.columns.length || prev.status !== 'ok' ? { columns: [], status: 'ok' } : prev)); return }
    const ac = new AbortController()
    const timer = setTimeout(() => {
      // Re-fetches what is missing if Open-Meteo was throttling (see watchWindAloftAlongRoute).
      watchWindAloftAlongRoute(waypoints, totalNm, maxAltFt, API_BASE, ac.signal, totalNm / 6,
        (columns, status) => setState({ columns, status }))
    }, DEBOUNCE_MS)
    return () => { clearTimeout(timer); ac.abort() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, totalNm, maxAltFt, enabled])

  return state
}
