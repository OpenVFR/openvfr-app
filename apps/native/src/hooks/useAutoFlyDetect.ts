/**
 * Watches GPS fixes for takeoff / landing and reports a suggestion. Detection
 * logic lives in @open-vfr/shared/autoFlyDetect (shared with web).
 *
 * `fix` is the live GPS position, or null when the simulator drives flight
 * (sim never auto-starts or auto-stops).
 *
 * A start needs the aircraft well above the highest ground around
 * it (useGroundMaxElevation). That lookup costs an elevation request without
 * a downloaded DEM, so it only runs when it could decide a start: not
 * flying, at start speed, and already GROUND_CHECK_CLIMB_FT above the lowest
 * altitude of the last GROUND_CHECK_WINDOW_MS (the detector's own altitude
 * window). A takeoff climbs that within a minute; level driving never does.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import {
  initialAutoFlyState, stepAutoFly, lowestRecentAltFt, DEFAULT_AUTO_FLY_THRESHOLDS,
  type AutoFlyMode, type AutoFlyState, type AutoFlyThresholds,
} from '@open-vfr/shared/autoFlyDetect'
import type { GpsPosition } from '../utils/gpsTypes'
import { useGroundMaxElevation } from './useGroundMaxElevation'

/** Climb (ft) within GROUND_CHECK_WINDOW_MS from which the highest ground
 *  around is looked up: above GPS altitude noise, below a takeoff's first
 *  minute (300+ ft), more than most roads climb in that time. */
const GROUND_CHECK_CLIMB_FT = 200
const GROUND_CHECK_WINDOW_MS = 2 * 60_000

export function useAutoFlyDetect(
  mode: AutoFlyMode,
  fix: GpsPosition | null,
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
  // Highest ground around the fix, looked up only when it could decide a
  // start (see the module doc). Reads the detector's altitude window.
  const lowest = fix ? lowestRecentAltFt(stateRef.current, Date.now(), GROUND_CHECK_WINDOW_MS) : null
  const groundFt = useGroundMaxElevation(
    fix,
    mode !== 'off' && !flying && fix != null && fix.speedKts >= thresholds.airborneKts
      && lowest != null && fix.altFt - lowest >= GROUND_CHECK_CLIMB_FT,
    // A new fast episode (and a new lookup budget) after slowing right down.
    fix != null && fix.speedKts < thresholds.landedKts,
  )
  // Ref, not a dep: a new terrain sample must not count as a fix.
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
