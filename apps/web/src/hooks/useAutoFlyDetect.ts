/**
 * Watches own-position fixes for takeoff / landing and reports a suggestion.
 * Detection logic lives in @open-vfr/shared/autoFlyDetect (shared with native).
 *
 * `fix` is the passive position while not flying, the GPS position while in
 * GPS flying mode, and null otherwise (simulator / external feeds never
 * auto-start or auto-stop).
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import {
  initialAutoFlyState, stepAutoFly, DEFAULT_AUTO_FLY_THRESHOLDS,
  type AutoFlyMode, type AutoFlyState, type AutoFlyThresholds,
} from '@open-vfr/shared/autoFlyDetect'

export interface AutoFlyFixInput { speedKts: number | null; accuracyM: number }

export function useAutoFlyDetect(
  mode: AutoFlyMode,
  fix: AutoFlyFixInput | null,
  flying: boolean,
  actions: { start: () => void; stop: () => void },
  thresholds: AutoFlyThresholds = DEFAULT_AUTO_FLY_THRESHOLDS,
): { suggestion: 'start' | 'stop' | null; dismiss: () => void; accept: () => void } {
  const stateRef = useRef<AutoFlyState>(initialAutoFlyState())
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  // Ref, not a dep: a new thresholds object must not re-run the detector and double-count a fix.
  const thresholdsRef = useRef(thresholds)
  thresholdsRef.current = thresholds
  const [suggestion, setSuggestion] = useState<'start' | 'stop' | null>(null)

  // A pending suggestion is moot once the mode flipped (manual start/stop).
  useEffect(() => { setSuggestion(null) }, [flying])
  useEffect(() => { if (mode === 'off') setSuggestion(null) }, [mode])

  useEffect(() => {
    if (mode === 'off' || !fix || fix.speedKts === null) return
    const r = stepAutoFly(stateRef.current, { speedKts: fix.speedKts, accuracyM: fix.accuracyM, t: Date.now() }, flying, thresholdsRef.current)
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
