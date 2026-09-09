/**
 * useWind — periodic winds-aloft fetch for the current GPS position, used
 * by GaugesBar's WIND field. Mirrors the web GoFlyingPanel wind-fetch
 * pattern: fetch immediately on first position, then every 5 minutes, with
 * a 30 s retry on failure.
 */

import { useEffect, useRef, useState } from 'react'
import { fetchWind, type WindAloft } from '@open-vfr/shared/fetchWind'
import { API_BASE } from '../config'
import type { GpsPosition } from '../utils/gpsTypes'

const REFRESH_MS = 5 * 60 * 1000
const RETRY_MS   = 30_000

export function useWind(position: GpsPosition | null, enabled: boolean): WindAloft | null {
  const [wind, setWind] = useState<WindAloft | null>(null)
  const posRef      = useRef(position)
  const retryRef     = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetchedOnceRef = useRef(false)

  useEffect(() => { posRef.current = position }, [position])

  useEffect(() => {
    if (!enabled) {
      setWind(null)
      fetchedOnceRef.current = false
      return
    }

    const doFetch = () => {
      const pos = posRef.current
      if (!pos) return
      fetchWind(pos.lat, pos.lng, pos.altFt > 100 ? pos.altFt : null, API_BASE)
        .then(setWind)
        .catch(() => {
          retryRef.current = setTimeout(doFetch, RETRY_MS)
        })
    }

    if (position && !fetchedOnceRef.current) {
      fetchedOnceRef.current = true
      doFetch()
    }

    const id = setInterval(doFetch, REFRESH_MS)
    return () => { clearInterval(id); if (retryRef.current) clearTimeout(retryRef.current) }
  }, [enabled, position])

  return wind
}
