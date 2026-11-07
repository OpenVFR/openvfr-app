/**
 * useRegionalNotams — polls GET /api/notam/regional for FIR-wide NOTAMs
 * (restricted/danger areas, navaid outages, AIRAC amendments, military
 * notices) that aren't tied to any single airport ICAO.
 *
 * Server-side, this data is already refreshed by a shared ~3.3-minute
 * poller against NMS-API (see apps/api/src/notam.ts) — this hook just
 * reads that cache, so a similarly relaxed client poll interval is fine
 * (no reason to poll faster than the data itself changes).
 *
 * `regions` scopes the request to the countries the user is working in
 * (selected region + route + position, see @open-vfr/shared/
 * notamRegionScope's notamRegionsFor()). A change in the set triggers an
 * immediate re-fetch; the previous list stays visible until it arrives.
 * The poller is shared per region set (sharedPoll), so the map and the
 * Pre-flight Check panel do not poll twice.
 */

import { useEffect, useState } from 'react'
import { fetchRegionalNotams, type NotamItem } from '@open-vfr/shared/fetchNotam'
import { subscribePoll } from '@open-vfr/shared/sharedPoll'
import { API_BASE_URL } from '../utils/env'

const POLL_INTERVAL_MS = 5 * 60 * 1000 // 5 min -- server refreshes ~every 3.3 min
const NO_NOTAMS: NotamItem[] = []

export function useRegionalNotams(enabled: boolean, regions: string[]): NotamItem[] {
  return useRegionalNotamsState(enabled, regions).notams
}

/** Like useRegionalNotams, plus `failed`: the latest request failed (cleared on the next success). */
export function useRegionalNotamsState(enabled: boolean, regions: string[]): { notams: NotamItem[]; failed: boolean } {
  // Stable key: a new array with the same codes must not restart polling.
  const regionsKey = [...new Set(regions)].sort().join(',')
  const [notams, setNotams] = useState<NotamItem[]>(NO_NOTAMS)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!enabled) { setNotams((prev) => (prev.length ? NO_NOTAMS : prev)); setFailed(false); return }
    return subscribePoll(
      `web-notam:${regionsKey}`,
      async () => (await fetchRegionalNotams(API_BASE_URL, undefined, undefined, regionsKey ? regionsKey.split(',') : undefined)).notams,
      POLL_INTERVAL_MS,
      (d) => { setNotams(d); setFailed(false) },
      () => setFailed(true),
    )
  }, [enabled, regionsKey])

  return { notams, failed }
}
