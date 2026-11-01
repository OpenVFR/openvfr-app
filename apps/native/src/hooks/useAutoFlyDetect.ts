/**
 * Watches GPS fixes for takeoff / landing and reports a suggestion. Detection
 * logic lives in @open-vfr/shared/autoFlyDetect (shared with web).
 *
 * `fix` is the live GPS position, or null when the simulator drives flight
 * (sim never auto-starts or auto-stops).
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import {
  initialAutoFlyState, stepAutoFly, DEFAULT_AUTO_FLY_THRESHOLDS,
  type AutoFlyMode, type AutoFlyState, type AutoFlyThresholds,
} from '@open-vfr/shared/autoFlyDetect'
import type { GpsPosition } from '../utils/gpsTypes'

export function useAutoFlyDetect(
  mode: AutoFlyMode,
  fix: GpsPosition | null,
  flying: boolean,
  actions: { start: () => void; stop: () => void },
  thresholds: AutoFlyThresholds = DEFAULT_AUTO_FLY_THRESHOLDS,
  /** Terrain elevation (ft AMSL) under the fix; null = unknown. A start
   *  needs the aircraft well above it (see @open-vfr/shared/autoFlyDetect). */
  groundFt: number | null = null,
): { suggestion: 'start' | 'stop' | null; dismiss: () => void; accept: () => void } {
  const stateRef = useRef<AutoFlyState>(initialAutoFlyState())
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  // Ref, not a dep: a new thresholds object must not re-run the detector and double-count a fix.
  const thresholdsRef = useRef(thresholds)
  thresholdsRef.current = thresholds
  // Ref for the same reason: a new terrain sample must not count as a fix.
  const groundRef = useRef(groundFt)
  groundRef.current = groundFt
  const [suggestion, setSuggestion] = useState<'start' | 'stop' | null>(null)

  useEffect(() => { setSuggestion(null) }, [flying])
  useEffect(() => { if (mode === 'off') setSuggestion(null) }, [mode])

  useEffect(() => {
    if (mode === 'off' || !fix) return
    const r = stepAutoFly(stateRef.current, {
      speedKts: fix.speedKts, accuracyM: fix.accuracy, t: Date.now(),
      altFt: fix.altFt, groundFt: groundRef.current,
    }, flying, thresholdsRef.current)
    stateRef.current = r.state
    if (!r.event) return
    const which = r.event === 'suggest-start' ? 'start' : 'stop'
    if (mode === 'auto') actionsRef.current[which]()
    else setSuggestion(which)
  }, [fix, mode, flying])

  const dismiss = useCallback(() => setSuggestion(null), [])
  const accept = useCallback(() => {
    setSuggestion(s => { if (s) actionsRef.current[s](); return null })
  }, [])
  return { suggestion, dismiss, accept }
}
