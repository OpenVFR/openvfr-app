/**
 * useSimFlight — internal (no external simulator / no hardware) flight
 * simulation for native, built on the shared SimFlightEngine.
 *
 * Native has no keyboard, so control is driven by touch instead:
 *   - Press HDG/SPEED/ALT +/- buttons for discrete steps; hold to repeat
 *     faster (see SimControlPanel's useHoldRepeat)
 *   - Tap the map to set a steer-toward target (like web's click-to-navigate)
 *   - Drag the aircraft icon to teleport it directly
 *
 * See SimControlPanel.tsx for the touch UI, and SimFlightEngine (shared)
 * for the actual physics tick loop.
 */

import { useRef, useState, useCallback, useEffect } from 'react'
import { SimFlightEngine } from '@open-vfr/shared/simFlightEngine'
import type { GpsPosition } from '../utils/gpsTypes'

export function useSimFlight() {
  const [position, setPosition]   = useState<GpsPosition | null>(null)
  const [active, setActive]       = useState(false)
  const [hasTarget, setHasTarget] = useState(false)
  const engineRef = useRef<SimFlightEngine | null>(null)

  if (!engineRef.current) {
    engineRef.current = new SimFlightEngine(
      (pos) => setPosition(pos),
      (t) => setHasTarget(t),
    )
  }

  const start = useCallback((initialPos: { lat: number; lng: number }, initialSpeedKts = 90, initialTrackDeg = 0, initialAltFt = 1000) => {
    engineRef.current!.start(initialPos, initialSpeedKts, initialTrackDeg, initialAltFt)
    setActive(true)
  }, [])

  const stop = useCallback(() => {
    engineRef.current!.stop()
    setActive(false)
    setPosition(null)
    setHasTarget(false)
  }, [])

  const adjustHeading = useCallback((dir: -1 | 1) => {
    engineRef.current!.adjustHeading(dir)
  }, [])

  const adjustSpeed = useCallback((dir: -1 | 1) => {
    engineRef.current!.adjustSpeed(dir)
  }, [])

  const adjustAlt = useCallback((dir: -1 | 1) => {
    engineRef.current!.adjustAlt(dir)
  }, [])

  const setTarget = useCallback((lat: number, lng: number) => {
    engineRef.current!.setTarget(lat, lng)
  }, [])

  const clearTarget = useCallback(() => {
    engineRef.current!.clearTarget()
  }, [])

  const teleport = useCallback((lat: number, lng: number) => {
    engineRef.current!.teleport(lat, lng)
  }, [])

  const advanceNm = useCallback((nm: number) => {
    engineRef.current!.advanceNm(nm)
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => { engineRef.current?.stop() }
  }, [])

  return { position, active, hasTarget, start, stop, adjustHeading, adjustSpeed, adjustAlt, setTarget, clearTarget, teleport, advanceNm }
}
