/**
 * useGpsVerticalSpeed — best-effort vertical speed (ft/min) derived purely
 * from consecutive GPS altitude samples, for web's VirtualRadar climb/
 * descent-aware trajectory line.
 *
 * Native's equivalent (apps/native/src/hooks/useAltitudeSource.ts) tiers
 * BlueFly-vario > internal-barometer > GPS, and only ever surfaces a vspeed
 * number for the top two (real baro/vario) tiers — see that file's header
 * and AGENTS.md for why: raw GPS-altitude-derived vertical speed is noisy
 * enough (GPS vertical accuracy is typically several times worse than
 * horizontal) that the project treats it as too unreliable for e.g.
 * airspace-ceiling warnings.
 *
 * Web has no equivalent baro/vario sensor access at all (no BLE/native
 * pressure sensor story in a browser), so there is no better source
 * available here — this hook is a deliberate, explicitly-labelled
 * lower-quality fallback so web still gets *a* climb/descent-aware
 * trajectory line rather than none, smoothed with an EMA to blunt the worst
 * of the GPS altitude jitter. Treat its output as indicative only, same
 * spirit as the rest of this chart's "situational awareness, not proof"
 * framing.
 */

import { useRef, useState, useEffect } from 'react'
import type { GpsPosition } from '../utils/gpsTypes'

const EMA_ALPHA   = 0.3   // smoothing weight for each new sample
const STALE_MS    = 5000  // treat a gap this large as a reset, not a spike
const MIN_DT_MS   = 250   // ignore sub-250ms ticks — division noise otherwise

export function useGpsVerticalSpeed(position: GpsPosition | null): number | null {
  const [vsFtMin, setVsFtMin] = useState<number | null>(null)
  const prevRef = useRef<{ altFt: number; ts: number } | null>(null)
  const emaRef  = useRef<number | null>(null)

  useEffect(() => {
    if (!position) {
      prevRef.current = null
      emaRef.current  = null
      setVsFtMin(null)
      return
    }
    const now = Date.now()
    const prev = prevRef.current
    prevRef.current = { altFt: position.altFt, ts: now }
    if (!prev || now - prev.ts > STALE_MS) {
      // First sample, or a long gap (app backgrounded, GPS reacquiring) —
      // reset rather than compute a spurious rate across the gap.
      emaRef.current = null
      setVsFtMin(null)
      return
    }
    const dtMs = now - prev.ts
    if (dtMs < MIN_DT_MS) return
    const instantFtMin = ((position.altFt - prev.altFt) / dtMs) * 60000
    emaRef.current = emaRef.current == null ? instantFtMin : emaRef.current + EMA_ALPHA * (instantFtMin - emaRef.current)
    setVsFtMin(Math.round(emaRef.current))
  }, [position])

  return vsFtMin
}
