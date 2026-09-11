/**
 * useRegionalNotams (native) — polls GET /api/notam/regional for FIR-wide
 * NOTAMs (restricted/danger areas, navaid outages, AIRAC amendments,
 * military notices) that aren't tied to any single airport ICAO.
 *
 * Mirrors apps/web/src/hooks/useRegionalNotams.ts, but uses native's bearer
 * token auth (authHeaders()) instead of the browser's cookie-based
 * credentials:'include' -- see apps/native/src/utils/authClient.ts.
 */

import { useEffect, useRef, useState } from 'react'
import { fetchRegionalNotams, type NotamItem } from '@open-vfr/shared/fetchNotam'
import { API_BASE } from '../config'
import { authHeaders } from '../utils/authClient'

const POLL_INTERVAL_MS = 5 * 60 * 1000 // 5 min -- server refreshes ~every 3.3 min

export function useRegionalNotams(enabled: boolean): NotamItem[] {
  const [notams, setNotams] = useState<NotamItem[]>([])
  const enabledRef = useRef(enabled)
  useEffect(() => { enabledRef.current = enabled }, [enabled])

  useEffect(() => {
    if (!enabled) { setNotams([]); return }

    let destroyed = false

    async function poll() {
      try {
        const headers = await authHeaders()
        const data = await fetchRegionalNotams(API_BASE, undefined, headers)
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
  }, [enabled])

  return notams
}
