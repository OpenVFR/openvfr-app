/**
 * useFieldQnh — self-calibrates QNH from the phone barometer while parked
 * at a known aerodrome (see @open-vfr/shared/fieldQnh). Smooths candidate
 * readings, then keeps the last value after take-off (pressure drifts
 * slowly) until it ages out. Only a fallback: a live METAR-derived QNH
 * always takes precedence (see useAltitudeSource).
 */

import { useEffect, useRef, useState } from 'react'
import { fieldQnhCandidate } from '@open-vfr/shared/fieldQnh'
import { useNearestAerodrome } from './useNearestAerodrome'
import type { GpsPosition } from '../utils/gpsTypes'

const EMA_ALPHA = 0.1                 // ~10 s time constant at 1 Hz
const MIN_SAMPLES = 10                // require this many parked samples before trusting
const MAX_AGE_MS = 3 * 60 * 60_000    // pressure systems move; don't trust it all day

export function useFieldQnh(
  position: GpsPosition | null,
  pressureHpa: number | null,
  enabled: boolean,
): number | null {
  const nearest = useNearestAerodrome(enabled ? position : null)
  const [qnh, setQnh] = useState<number | null>(null)
  const stateRef = useRef<{ value: number; n: number; at: number } | null>(null)

  useEffect(() => {
    if (!enabled) { stateRef.current = null; setQnh(null); return }
    const now = Date.now()
    const s = stateRef.current
    if (s && now - s.at > MAX_AGE_MS) { stateRef.current = null; setQnh(null) }
    if (!position || !nearest || pressureHpa == null) return

    const cand = fieldQnhCandidate({
      pressureHpa,
      elevationFt: nearest.elevationFt,
      distanceNm:  nearest.distanceNm,
      speedKts:    position.speedKts,
    })
    if (cand == null) return

    const prev = stateRef.current
    // A big jump from the running value means a different field/reading: restart.
    const next = prev && Math.abs(cand - prev.value) < 5
      ? { value: prev.value + EMA_ALPHA * (cand - prev.value), n: prev.n + 1, at: now }
      : { value: cand, n: 1, at: now }
    stateRef.current = next
    if (next.n >= MIN_SAMPLES) setQnh(next.value)
  }, [enabled, position, pressureHpa, nearest])

  return qnh
}
