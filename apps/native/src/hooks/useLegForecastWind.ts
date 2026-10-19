/**
 * useLegForecastWind — forecast wind per route leg (SkyDemon-style): evaluated
 * for each leg's midpoint, altitude and expected time, recomputed whenever the
 * route / altitude / takeoff time changes. Manual per-leg overrides are applied
 * by the caller and win over this.
 */

import { useCallback, useEffect, useState } from 'react'
import { API_BASE } from '../config'
import type { WindAloft } from '@open-vfr/shared/fetchWind'
import { fetchWindForecastMany, clearWindForecastCache, isForecastable } from '@open-vfr/shared/windForecast'

export interface LegWindQuery { lat: number; lng: number; altFt: number | null; at: Date }

const DEBOUNCE_MS = 500

export function useLegForecastWind(queries: LegWindQuery[], enabled: boolean) {
  const [winds, setWinds] = useState<(WindAloft | null)[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [tick, setTick] = useState(0)
  // 15-min time buckets: tiny ETE changes don't refetch.
  const key = queries
    .map((q) => `${q.lat.toFixed(3)},${q.lng.toFixed(3)},${q.altFt ?? ''},${Math.round(q.at.getTime() / 900_000)}`)
    .join('|')

  useEffect(() => {
    if (!enabled || queries.length === 0) { setWinds([]); setError(false); return }
    const ac = new AbortController()
    const timer = setTimeout(() => {
      setLoading(true)
      fetchWindForecastMany(queries, API_BASE, ac.signal)
        .then((w) => {
          if (ac.signal.aborted) return
          setWinds(w)
          setError(queries.some((q) => isForecastable(q.at)) && w.every((x) => x == null))
        })
        .catch(() => { /* aborted */ })
        .finally(() => { if (!ac.signal.aborted) setLoading(false) })
    }, DEBOUNCE_MS)
    return () => { clearTimeout(timer); ac.abort() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, tick])

  /** Force a fresh fetch (bypasses the cache). */
  const refresh = useCallback(() => { clearWindForecastCache(); setTick((t) => t + 1) }, [])

  return { winds, loading, error, refresh }
}
