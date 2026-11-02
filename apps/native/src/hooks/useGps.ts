/**
 * useGps — wraps the background-capable location task to produce a stream
 * of GpsPosition values.
 *
 * The request follows what the pilot is doing (@open-vfr/shared/gpsPolicy,
 * applied through ../tasks/locationTask): while a GPS flight is on, expo-task-
 * manager's startLocationUpdatesAsync with an Android foreground service keeps
 * GPS fixes flowing regardless of screen state (plain foreground watches get
 * suspended by the OS as soon as the screen locks or the app backgrounds, which
 * silently killed flight-log recording and moving-map tracking mid-flight). On
 * the ground there is no service, the request is cheap once the device has been
 * still for two minutes, and nothing is requested in the background.
 *
 * Matches the GpsPosition type used in the web project (src/utils/gpsTypes.ts)
 * so all shared navigation utilities (routeCalc, fuelCalc, etc.) can be used
 * without modification.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { AppState } from 'react-native'
import { addLocationListener, setLocationRequest, stopBackgroundLocation } from '../tasks/locationTask'
import { GPS_REQUESTS, gpsTier, isMoving, type GpsFixLike, type GpsTier } from '@open-vfr/shared/gpsPolicy'
import type { GpsPosition } from '../utils/gpsTypes'
import { mslAltitudeFromFix } from '@open-vfr/shared/gpsAltitude'
import { gpsAltitudeReference } from '@open-vfr/shared/gpsAltitudeReference'

// Altitude: expo-location's `next` Position carries `altitude` (above the
// WGS-84 ellipsoid, both platforms) and `mslAltitude` (the OS's own sea-level
// height: iOS always, Android 14+). The OS value is used when present, else
// the ellipsoidal height minus the EGM96 geoid (@open-vfr/shared/geoid).
// gpsAltitudeReference() is the on-ground check of the `altitude` field, read
// per fix because the verdict can arrive mid-session.

export type GpsStatus = 'idle' | 'requesting' | 'active' | 'denied' | 'unavailable'

export type UseGpsResult = {
  position:  GpsPosition | null
  status:    GpsStatus
  /** Start watching GPS (foreground + background). No-op if already active. */
  start:     () => Promise<void>
  /** Stop watching GPS and release the background task. */
  stop:      () => void
  /** Tell the hook whether a flight is in progress: only then is the foreground service (and best accuracy at 1 Hz with the screen off) used. */
  setFlying: (flying: boolean) => void
}

const M_TO_FT = 3.28084
// Below this ground speed, GPS course-over-ground (coords.heading) is
// essentially undefined/noise — no real track exists when nearly stationary,
// and it's especially bad indoors with multipath. Hold the last stable
// heading instead of forwarding the raw jitter (which could swing 180°+
// while sitting still), so the map's aircraft icon and the TT gauge don't
// spin randomly at rest.
const MIN_SPEED_FOR_TRACK_KTS = 3
// Fixes arrive about once a second even when the device is standing still,
// each with a few metres of jitter, and every setPosition re-renders the
// whole map screen. Below this speed a fix only counts as a change when it
// has moved at least STATIONARY_DEADBAND_M or the altitude/accuracy shifted
// noticeably. While moving, every fix goes through.
const STATIONARY_SPEED_KTS  = 1
const STATIONARY_DEADBAND_M = 2

function sameFix(a: GpsPosition, b: GpsPosition): boolean {
  if (a.speedKts >= STATIONARY_SPEED_KTS || b.speedKts >= STATIONARY_SPEED_KTS) return false
  const dLatM = (a.lat - b.lat) * 111_320
  const dLngM = (a.lng - b.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180)
  return Math.hypot(dLatM, dLngM) < STATIONARY_DEADBAND_M
    && Math.abs(a.altFt - b.altFt) < 10
    && Math.abs(a.accuracy - b.accuracy) < 5
    && a.trackDeg === b.trackDeg
}

/**
 * @param opts.paused While true, fixes are not published as state (the
 *   location service keeps running). The map screen passes true while a
 *   simulator drives the position: a real fix would otherwise re-render the
 *   whole screen once a second for a position nobody shows.
 */
export function useGps(opts: { paused?: boolean } = {}): UseGpsResult {
  const [position, setPosition]  = useState<GpsPosition | null>(null)
  const pausedRef                = useRef(!!opts.paused)
  pausedRef.current              = !!opts.paused
  const [status, setStatus]      = useState<GpsStatus>('idle')
  const activeRef                = useRef(false)
  const lastStableTrackRef       = useRef(0)
  const unsubscribeRef           = useRef<(() => void) | null>(null)

  // What the device is asked for follows the situation (see gpsPolicy): the
  // flight tier (foreground service) only while flying, otherwise a fast tier for
  // two minutes after opening the app or the last movement, then a cheap one.
  const flyingRef       = useRef(false)
  const lastMovedRef    = useRef<number | null>(null)
  const tierRef         = useRef<GpsTier | null>(null)
  const prevFixRef      = useRef<GpsFixLike | null>(null)
  const backgroundRef   = useRef(false)
  const failureRef      = useRef<'foreground-denied' | 'unavailable'>('foreground-denied')

  const applyTier = useCallback(async (): Promise<boolean> => {
    if (!activeRef.current) return true
    const tier = gpsTier({ flying: flyingRef.current, lastMovedAtMs: lastMovedRef.current, nowMs: Date.now() })
    // Off the ground-tier request while the app is in the background and no flight is running.
    if (backgroundRef.current && tier !== 'flight') {
      if (tierRef.current !== null) { tierRef.current = null; await stopBackgroundLocation().catch(() => {}) }
      return true
    }
    if (tierRef.current === tier) return true
    // Set only once the request is running: a refused or failed start leaves no tier claimed, so the
    // next fix or tier change tries again instead of believing it is already applied.
    try {
      const result = await setLocationRequest(GPS_REQUESTS[tier])
      if (result !== 'ok') failureRef.current = result
      const ok = result === 'ok'
      tierRef.current = ok && activeRef.current ? tier : null  // stopped while the request was starting
      return ok
    } catch (err) {
      tierRef.current = null
      console.warn('[useGps] location request failed:', err)
      return false
    }
  }, [])

  const stop = useCallback(() => {
    unsubscribeRef.current?.()
    unsubscribeRef.current = null
    activeRef.current = false
    tierRef.current = null
    setStatus('idle')
    stopBackgroundLocation().catch(() => {})
  }, [])

  const start = useCallback(async () => {
    if (activeRef.current) return  // already watching

    setStatus('requesting')

    // Opening the app counts as movement: the fast tier for the first two minutes.
    lastMovedRef.current = Date.now()
    prevFixRef.current = null
    activeRef.current = true
    const ok = await applyTier()
    if (!ok) {
      activeRef.current = false
      tierRef.current = null
      setStatus(failureRef.current === 'unavailable' ? 'unavailable' : 'denied')
      return
    }
    setStatus('active')

    unsubscribeRef.current = addLocationListener((loc) => {
      const lat = loc.coordinates.latitude
      const lng = loc.coordinates.longitude
      const speedKts = loc.speed != null ? loc.speed * 1.943844 : 0  // m/s -> kts
      // Movement drives the tier even while a simulator has the position paused.
      const fixLike: GpsFixLike = { lat, lng, speedKts, accuracyM: loc.horizontalAccuracy ?? 0, tMs: loc.timestamp ?? Date.now() }
      if (isMoving(prevFixRef.current, fixLike)) lastMovedRef.current = Date.now()
      prevFixRef.current = fixLike
      void applyTier()
      if (pausedRef.current) return
      if (speedKts >= MIN_SPEED_FOR_TRACK_KTS && loc.heading != null) {
        lastStableTrackRef.current = loc.heading
      }
      const alt = mslAltitudeFromFix(
        { altitude: loc.altitude, mslAltitude: loc.mslAltitude, lat, lng },
        gpsAltitudeReference(),
      )
      const next: GpsPosition = {
        lat,
        lng,
        altFt:    alt ? alt.mslM * M_TO_FT : 0,
        ...(loc.altitude != null ? { rawAltM: loc.altitude } : {}),
        ...(loc.verticalAccuracy != null ? { altAccuracyM: loc.verticalAccuracy } : {}),
        speedKts,
        trackDeg: lastStableTrackRef.current,
        accuracy: loc.horizontalAccuracy ?? 0,
      }
      setPosition((prev) => (prev && sameFix(prev, next) ? prev : next))
    })
  }, [applyTier])

  const setFlying = useCallback((flying: boolean) => {
    flyingRef.current = flying
    // Leaving a flight: count it as movement so the fast tier covers the taxi in.
    if (!flying) lastMovedRef.current = Date.now()
    void applyTier()
  }, [applyTier])

  // The ground tiers use no foreground service, so nothing is asked of the
  // receiver while the app is in the background (a pilot who has put the tablet
  // away). Back in the foreground it counts as movement: fast tier again.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const bg = state !== 'active'
      if (bg === backgroundRef.current) return
      backgroundRef.current = bg
      if (!bg) lastMovedRef.current = Date.now()
      void applyTier()
    })
    return () => sub.remove()
  }, [applyTier])

  // Clean up on unmount — release the listener, but deliberately do NOT stop
  // the background task itself here: MapScreen mounts/unmounts this hook
  // across navigation, and a flight in progress should keep recording even
  // if the pilot briefly navigates to Settings/Plan and back. Explicit
  // stop() (called from handleStopFlight) is the only thing that ends
  // background tracking.
  useEffect(() => () => { unsubscribeRef.current?.() }, [])

  return { position, status, start, stop, setFlying }
}
