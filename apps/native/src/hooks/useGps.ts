/**
 * useGps — wraps the background-capable location task to produce a stream
 * of GpsPosition values.
 *
 * Uses expo-task-manager + expo-location's startLocationUpdatesAsync (via
 * ../tasks/locationTask) instead of plain watchPositionAsync — plain
 * foreground watches get suspended by the OS as soon as the screen locks or
 * the app backgrounds, which silently killed flight-log recording and moving-
 * map tracking mid-flight. The background task + Android foreground-service
 * notification keep GPS fixes flowing continuously regardless of screen state.
 *
 * Matches the GpsPosition type used in the web project (src/utils/gpsTypes.ts)
 * so all shared navigation utilities (routeCalc, fuelCalc, etc.) can be used
 * without modification.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { addLocationListener, startBackgroundLocation, stopBackgroundLocation } from '../tasks/locationTask'
import type { GpsPosition } from '../utils/gpsTypes'

export type GpsStatus = 'idle' | 'requesting' | 'active' | 'denied' | 'unavailable'

export type UseGpsResult = {
  position:  GpsPosition | null
  status:    GpsStatus
  /** Start watching GPS (foreground + background). No-op if already active. */
  start:     () => Promise<void>
  /** Stop watching GPS and release the background task. */
  stop:      () => void
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

export function useGps(): UseGpsResult {
  const [position, setPosition]  = useState<GpsPosition | null>(null)
  const [status, setStatus]      = useState<GpsStatus>('idle')
  const activeRef                = useRef(false)
  const lastStableTrackRef       = useRef(0)
  const unsubscribeRef           = useRef<(() => void) | null>(null)

  const stop = useCallback(() => {
    unsubscribeRef.current?.()
    unsubscribeRef.current = null
    activeRef.current = false
    setStatus('idle')
    stopBackgroundLocation().catch(() => {})
  }, [])

  const start = useCallback(async () => {
    if (activeRef.current) return  // already watching

    setStatus('requesting')

    const result = await startBackgroundLocation()
    if (result !== 'ok') {
      setStatus('denied')
      return
    }

    activeRef.current = true
    setStatus('active')

    unsubscribeRef.current = addLocationListener((loc) => {
      const coords = loc.coords
      const speedKts = coords.speed != null ? coords.speed * 1.943844 : 0  // m/s -> kts
      if (speedKts >= MIN_SPEED_FOR_TRACK_KTS && coords.heading != null) {
        lastStableTrackRef.current = coords.heading
      }
      const next: GpsPosition = {
        lat:      coords.latitude,
        lng:      coords.longitude,
        altFt:    coords.altitude != null ? coords.altitude * M_TO_FT : 0,
        speedKts,
        trackDeg: lastStableTrackRef.current,
        accuracy: coords.accuracy ?? 0,
      }
      setPosition((prev) => (prev && sameFix(prev, next) ? prev : next))
    })
  }, [])

  // Clean up on unmount — release the listener, but deliberately do NOT stop
  // the background task itself here: MapScreen mounts/unmounts this hook
  // across navigation, and a flight in progress should keep recording even
  // if the pilot briefly navigates to Settings/Plan and back. Explicit
  // stop() (called from handleStopFlight) is the only thing that ends
  // background tracking.
  useEffect(() => () => { unsubscribeRef.current?.() }, [])

  return { position, status, start, stop }
}
