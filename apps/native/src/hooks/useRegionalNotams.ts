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
 * The poller is shared per region set (sharedPoll), so the map and the plan
 * screen do not poll twice.
 */

import { useEffect, useState } from 'react'
import { fetchRegionalNotams, type NotamItem } from '@open-vfr/shared/fetchNotam'
import { subscribePoll } from '@open-vfr/shared/sharedPoll'
import { API_BASE } from '../config'
import { authHeaders } from '../utils/authClient'

const POLL_INTERVAL_MS = 5 * 60 * 1000 // 5 min -- server refreshes ~every 3.3 min
const NO_NOTAMS: NotamItem[] = []

export function useRegionalNotams(enabled: boolean, regions: string[]): NotamItem[] {
  return useRegionalNotamsState(enabled, regions).notams
}

/** Like useRegionalNotams, plus `failed`: no list has arrived yet and the request failed. A list that
 *  arrived earlier stays in use, so a later failed refresh is not a failure. */
export function useRegionalNotamsState(enabled: boolean, regions: string[]): { notams: NotamItem[]; failed: boolean } {
  // Stable key: a new array with the same codes must not restart polling.
  const regionsKey = [...new Set(regions)].sort().join(',')
  const [notams, setNotams] = useState<NotamItem[]>(NO_NOTAMS)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
    if (!enabled) { setNotams((prev) => (prev.length ? NO_NOTAMS : prev)); return }
    let got = false
    // One poller per region set, shared by every screen that asks for it (map, plan).
    return subscribePoll(
      `native-notam:${regionsKey}`,
      async () => {
        const headers = await authHeaders()
        return (await fetchRegionalNotams(API_BASE, undefined, headers, regionsKey ? regionsKey.split(',') : undefined)).notams
      },
      POLL_INTERVAL_MS,
      (d) => { got = true; setNotams(d); setFailed(false) },
      () => { if (!got) setFailed(true) },
    )
  }, [enabled, regionsKey])

  return { notams, failed }
}
