/**
 * useRegionalNotams — polls GET /api/notam/regional for FIR-wide NOTAMs
 * (restricted/danger areas, navaid outages, AIRAC amendments, military
 * notices) that aren't tied to any single airport ICAO.
 *
 * Server-side, this data is already refreshed by a shared ~3.3-minute
 * poller against NMS-API (see apps/api/src/notam.ts) — this hook just
 * reads that cache, so a similarly relaxed client poll interval is fine
 * (no reason to poll faster than the data itself changes).
 */

import { useEffect, useRef, useState } from 'react'
import { fetchRegionalNotams, type NotamItem } from '@open-vfr/shared/fetchNotam'
import { API_BASE_URL } from '../utils/env'

const POLL_INTERVAL_MS = 5 * 60 * 1000 // 5 min -- server refreshes ~every 3.3 min

export function useRegionalNotams(enabled: boolean): NotamItem[] {
  const [notams, setNotams] = useState<NotamItem[]>([])
  const enabledRef = useRef(enabled)
  useEffect(() => { enabledRef.current = enabled }, [enabled])

  useEffect(() => {
    if (!enabled) { setNotams([]); return }

    let destroyed = false
    const ac = new AbortController()

    async function poll() {
      try {
        const data = await fetchRegionalNotams(API_BASE_URL, ac.signal)
        if (!destroyed) setNotams(data.notams)
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          // Stay silent -- same graceful-degradation pattern as weather/NOTAM
          // per-airport lookups. A transient failure just means the regional
          // circles/list don't update this cycle; next poll retries.
          console.warn('[useRegionalNotams] poll failed:', err)
        }
      }
    }

    void poll()
    const timer = setInterval(() => { void poll() }, POLL_INTERVAL_MS)

    return () => {
      destroyed = true
      ac.abort()
      clearInterval(timer)
    }
  }, [enabled])

  return notams
}
