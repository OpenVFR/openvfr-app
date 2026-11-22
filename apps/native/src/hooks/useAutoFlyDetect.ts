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
 * Two cases need no climb: the terrain model is downloaded (the lookup is then
 * free), or flying mode ended a short while ago (a stop in the air must find
 * its way back in level flight too).
 *
 * In flying mode the same lookup runs while the aircraft is slow: a landing is
 * only suggested close to the ground (a hover, or slow flight into the wind,
 * is no landing).
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import {
  initialAutoFlyState, stepAutoFly, lowestRecentAltFt, DEFAULT_AUTO_FLY_THRESHOLDS, AUTO_FLY_RECENT_FLIGHT_MS,
  type AutoFlyMode, type AutoFlyState, type AutoFlyThresholds,
} from '@open-vfr/shared/autoFlyDetect'
import type { GpsPosition } from '../utils/gpsTypes'
import { useGroundMaxElevation } from './useGroundMaxElevation'
import { getOfflineDem } from '../utils/terrainDem'
import { useRecentlyEnded } from './useRecentlyEnded'

/** Climb (ft) within GROUND_CHECK_WINDOW_MS from which the highest ground
 *  around is looked up: above GPS altitude noise, below a takeoff's first
 *  minute (300+ ft), more than most roads climb in that time. */
const GROUND_CHECK_CLIMB_FT = 200
const GROUND_CHECK_WINDOW_MS = 2 * 60_000
/** The offline terrain file is checked at most this often (the check reads file info on the JS thread). */
const DEM_CHECK_MS = 30_000
/** A landing is checked against the ground once the slow spell has settled this many fixes. */
const SLOW_FIXES_BEFORE_GROUND_CHECK = 3

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
  // Flying mode ended a short while ago (stopped in the air): the start then needs no climb.
  const recentFlight = useRecentlyEnded(flying, AUTO_FLY_RECENT_FLIGHT_MS)
  const demRef = useRef<{ at: number; has: boolean }>({ at: 0, has: false })
  const hasOfflineDem = (): boolean => {
    const now = Date.now()
    if (now - demRef.current.at >= DEM_CHECK_MS) demRef.current = { at: now, has: getOfflineDem() != null }
    return demRef.current.has
  }
  // Ref, not a dep: a new terrain sample must not count as a fix.
  const groundRef = useRef<number | null>(null)
  const usable = mode !== 'off' && fix != null && !fix.noSpeed && !fix.noAlt
  const slow = fix != null && fix.speedKts < thresholds.landedKts
  const startCheck = usable && !flying && fix.speedKts >= thresholds.airborneKts && (
    (lowest != null && fix.altFt - lowest >= GROUND_CHECK_CLIMB_FT)
    || recentFlight
    || hasOfflineDem()
  )
  // Flying and slow: the ground is only worth a request once the slow spell has settled (a taxi after
  // landing ends in a stop within seconds; a hover that keeps changing height is already no landing).
  const landingCheck = usable && flying && slow
    && (stateRef.current.slowFixes >= SLOW_FIXES_BEFORE_GROUND_CHECK || groundRef.current != null)
  const groundFt = useGroundMaxElevation(
    fix,
    startCheck || landingCheck,
    // A new lookup budget per episode: fast after slowing right down, or (flying) slow after flying on.
    flying ? fix != null && fix.speedKts >= thresholds.takeoffKts : slow,
  )
  groundRef.current = groundFt
  const [suggestion, setSuggestion] = useState<'start' | 'stop' | null>(null)

  useEffect(() => { setSuggestion(null) }, [flying])
  useEffect(() => { if (mode === 'off') setSuggestion(null) }, [mode])

  useEffect(() => {
    if (mode === 'off' || !fix) return
    // A fix without a speed or an altitude says nothing about either: unknown, not 0 kt / 0 ft
    // (0 kt read as landed, 0 ft as on the ground).
    const r = stepAutoFly(stateRef.current, {
      speedKts: fix.noSpeed ? NaN : fix.speedKts, accuracyM: fix.accuracy, t: Date.now(),
      altFt: fix.noAlt ? null : fix.altFt, groundFt: groundRef.current,
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
