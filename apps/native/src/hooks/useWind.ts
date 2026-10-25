/**
 * useWind — model wind at the current GPS position and altitude, used by
 * GaugesBar's WIND field. Fetched on the first position, again every
 * 5 minutes and whenever the aircraft moves into another wind level
 * (surface / pressure level, see fetchWind), and 30 s after a failure.
 *
 * The timers live in an effect that only restarts when one of those things
 * changes, NOT on every position tick: an earlier version listed the position
 * itself as a dependency, so every GPS / simulator tick (about 1 Hz) cleared
 * the 5-minute refresh and the 30 s retry. Wind was then fetched exactly once
 * -- a failed first fetch left the gauge at "–" for the whole flight, and a
 * successful one was never refreshed (the ground wind stayed up after
 * take-off).
 */

import { useEffect, useRef, useState } from 'react'
import { fetchWind, windLevelFor, type WindAloft } from '@open-vfr/shared/fetchWind'
import { API_BASE } from '../config'
import type { GpsPosition } from '../utils/gpsTypes'

const REFRESH_MS = 5 * 60 * 1000
const RETRY_MS   = 30_000

/** Altitude passed to fetchWind: below 100 ft the GPS altitude is treated as "on the ground". */
const windAltFt = (pos: GpsPosition) => (pos.altFt > 100 ? pos.altFt : null)

export function useWind(position: GpsPosition | null, enabled: boolean): WindAloft | null {
  const [wind, setWind] = useState<WindAloft | null>(null)
  const posRef = useRef(position)
  posRef.current = position

  const hasPosition = position != null
  // Changes only when the aircraft crosses into another wind level.
  const level = position ? windLevelFor(windAltFt(position)) : null

  useEffect(() => {
    if (!enabled) { setWind(null); return }
    if (!hasPosition) return
    const ac = new AbortController()
    let retry: ReturnType<typeof setTimeout> | undefined
    const doFetch = () => {
      clearTimeout(retry)
      const pos = posRef.current
      if (!pos) return
      fetchWind(pos.lat, pos.lng, windAltFt(pos), API_BASE, ac.signal)
        .then((w) => { if (!ac.signal.aborted) setWind(w) })
        .catch((err) => {
          if (ac.signal.aborted || (err as { name?: string }).name === 'AbortError') return
          // Keep the last wind on screen; try again soon instead of in 5 min.
          retry = setTimeout(doFetch, RETRY_MS)
        })
    }
    doFetch()
    const id = setInterval(doFetch, REFRESH_MS)
    return () => { ac.abort(); clearInterval(id); clearTimeout(retry) }
  }, [enabled, hasPosition, level])

  return wind
}
