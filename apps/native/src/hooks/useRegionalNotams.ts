/**
 * useRegionalNotams (native) — polls GET /api/notam/regional for FIR-wide
 * NOTAMs (restricted/danger areas, navaid outages, AIRAC amendments,
 * military notices) that aren't tied to any single airport ICAO.
 *
 * Mirrors apps/web/src/hooks/useRegionalNotams.ts, but uses native's bearer
 * token auth (authHeaders()) instead of the browser's cookie-based
 * credentials:'include' -- see apps/native/src/utils/authClient.ts.
 *
 * `regions` scopes the request to the countries the user is working in
 * (default region + route + position, see @open-vfr/shared/
 * notamRegionScope's notamRegionsFor()). A change in the set triggers an
 * immediate re-fetch; the previous list stays visible until it arrives.
 */

import { useEffect, useRef, useState } from 'react'
import { fetchRegionalNotams, type NotamItem } from '@open-vfr/shared/fetchNotam'
import { API_BASE } from '../config'
import { authHeaders } from '../utils/authClient'

const POLL_INTERVAL_MS = 5 * 60 * 1000 // 5 min -- server refreshes ~every 3.3 min

export function useRegionalNotams(enabled: boolean, regions: string[]): NotamItem[] {
  // Stable key: a new array with the same codes must not restart polling.
  const regionsKey = [...new Set(regions)].sort().join(',')
  const [notams, setNotams] = useState<NotamItem[]>([])
  const enabledRef = useRef(enabled)
  useEffect(() => { enabledRef.current = enabled }, [enabled])

  useEffect(() => {
    if (!enabled) { setNotams([]); return }

    let destroyed = false

    async function poll() {
      try {
        const headers = await authHeaders()
        const data = await fetchRegionalNotams(API_BASE, undefined, headers, regionsKey ? regionsKey.split(',') : undefined)
        if (!destroyed) setNotams(data.notams)
      } catch (err) {
        console.warn('[useRegionalNotams] poll failed:', err)
      }
    }

    void poll()
    const timer = setInterval(() => { void poll() }, POLL_INTERVAL_MS)

    return () => {
      destroyed = true
      clearInterval(timer)
    }
  }, [enabled, regionsKey])

  return notams
}
