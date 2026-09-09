/**
 * useBlueFlyVario — owns one BlueFlyBleManager instance, feeds every
 * complete line through the shared parser, and exposes the latest
 * VarioState + connection status. Wrap in VarioContext (like SimContext)
 * so exactly one instance exists app-wide — same lesson learned the hard
 * way with useSimInput (two independent instances was a real bug).
 *
 * No opt-in gate here — BlueFly is a real external instrument, unlike the
 * internal phone sensor (see native/docs/ble-vario-plan.md §0/§3c).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import {
  BlueFlyBleManager, type FoundDevice,
} from '../utils/BlueFlyBleManager'
import { requestBlePermissions } from '../utils/blePermissions'
import {
  validateChecksum, parseBfx, parseLk8ex1, type VarioState,
} from '@open-vfr/shared/blueflyVario'
import { BaroKalmanFilter } from '@open-vfr/shared/baroKalman'
const FT_PER_M = 3.28084
const MS_TO_FTMIN = 196.850394
// Matches BlueFlyBleManager's OUTPUT_RATE_DIVISOR (50Hz base / 10 = 5Hz).
const BFX_SAMPLE_DT_S = 0.2

export type VarioStatus = 'idle' | 'scanning' | 'connecting' | 'connected' | 'disconnected' | 'error' | 'permission-denied'

export type UseBlueFlyVarioOptions = {
  /** Persisted device ID to auto-connect to once on mount (app cold start /
   *  reload) — pass '' or undefined for "no remembered device". Since
   *  settings load from AsyncStorage asynchronously, this may start as
   *  undefined and become populated a moment later; the hook watches for
   *  that first real value and attempts exactly one silent auto-connect. */
  initialDeviceId?: string
  /** Called whenever the connected device ID changes (on successful connect,
   *  or '' on forget()) so the caller can persist it (VarioContext.tsx
   *  writes it to settings.varioAutoConnectId). */
  onDeviceIdChange?: (id: string) => void
}

export function useBlueFlyVario(qnhHpaRef: { current: number }, options: UseBlueFlyVarioOptions = {}) {
  const { initialDeviceId, onDeviceIdChange } = options

  const [status, setStatus]   = useState<VarioStatus>('idle')
  const [state, setState]     = useState<VarioState | null>(null)
  const [found, setFound]     = useState<FoundDevice[]>([])
  const [lastDeviceId, setLastDeviceId] = useState<string | null>(null)

  const managerRef   = useRef<BlueFlyBleManager | null>(null)
  const stopScanRef  = useRef<(() => void) | null>(null)
  const unsubLineRef = useRef<(() => void) | null>(null)
  const triedInitialRef = useRef(false)
  // One Kalman filter instance per connection — reset on each fresh connect
  // so a stale velocity estimate from a previous session never leaks in.
  // Runs on $BFX/$LK8EX1's own pressurePa field (not their vario/vario_cms
  // field — see BlueFlyBleManager's OUTPUT_MODE_BFX comment for why).
  const kalmanRef = useRef(new BaroKalmanFilter({ dt: BFX_SAMPLE_DT_S }))

  const getManager = useCallback(() => {
    if (!managerRef.current) managerRef.current = new BlueFlyBleManager()
    return managerRef.current
  }, [])

  const handleLine = useCallback((line: string) => {
    if (!validateChecksum(line)) return

    const bfx = parseBfx(line)
    if (bfx) {
      const { altitudeM, verticalMs } = kalmanRef.current.update(bfx.pressurePa, qnhHpaRef.current)
      setState({
        pressurePa:         bfx.pressurePa,
        baroAltitudeFt:     altitudeM * FT_PER_M,
        verticalSpeedFtMin: verticalMs * MS_TO_FTMIN,
        temperatureC:       bfx.tempC,
        batteryPercent:     bfx.batteryPct,
        batteryVolts:       bfx.batteryVolts,
        lastUpdated:        Date.now(),
      })
      return
    }

    const lk = parseLk8ex1(line)
    if (lk) {
      const { altitudeM, verticalMs } = kalmanRef.current.update(lk.pressurePa, qnhHpaRef.current)
      setState({
        pressurePa:         lk.pressurePa,
        baroAltitudeFt:     altitudeM * FT_PER_M,
        verticalSpeedFtMin: verticalMs * MS_TO_FTMIN,
        temperatureC:       lk.tempC,
        batteryPercent:     lk.batteryPct,
        batteryVolts:       null,
        lastUpdated:        Date.now(),
      })
    }
  }, [qnhHpaRef])

  const scan = useCallback(async () => {
    setFound([])
    setStatus('scanning')
    const granted = await requestBlePermissions()
    if (!granted) {
      setStatus('permission-denied')
      return
    }
    const manager = getManager()
    stopScanRef.current?.()
    stopScanRef.current = manager.scan((d) => {
      setFound(prev => (prev.some(x => x.id === d.id) ? prev : [...prev, d]))
    })
  }, [getManager])

  const stopScan = useCallback(() => {
    stopScanRef.current?.()
    stopScanRef.current = null
    setStatus(prev => (prev === 'scanning' ? 'idle' : prev))
  }, [])

  const connect = useCallback(async (deviceId: string) => {
    stopScan()
    setStatus('connecting')
    const granted = await requestBlePermissions()
    if (!granted) {
      setStatus('permission-denied')
      return
    }
    const manager = getManager()
    try {
      kalmanRef.current.reset()
      await manager.connect(deviceId)
      unsubLineRef.current?.()
      unsubLineRef.current = manager.onLine(handleLine)
      setLastDeviceId(deviceId)
      onDeviceIdChange?.(deviceId)
      setStatus('connected')
    } catch {
      setStatus('error')
    }
  }, [getManager, handleLine, stopScan, onDeviceIdChange])

  const disconnect = useCallback(() => {
    unsubLineRef.current?.()
    unsubLineRef.current = null
    managerRef.current?.disconnect()
    setState(null)
    setStatus('disconnected')
  }, [])

  /** Disconnect + forget the remembered device entirely — no more silent
   *  auto-reconnect on foreground/app-start until the pilot connects again. */
  const forget = useCallback(() => {
    disconnect()
    setLastDeviceId(null)
    onDeviceIdChange?.('')
  }, [disconnect, onDeviceIdChange])

  // Auto-connect once on app start / reload, as soon as a remembered device
  // ID becomes available from persisted settings (which load asynchronously
  // from AsyncStorage, hence watching for the first real value rather than
  // just checking on mount).
  useEffect(() => {
    if (triedInitialRef.current) return
    if (!initialDeviceId) return
    triedInitialRef.current = true
    connect(initialDeviceId).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDeviceId])

  // Reconnect silently on foreground if we were previously connected.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && lastDeviceId && status !== 'connected' && status !== 'connecting') {
        connect(lastDeviceId).catch(() => {})
      }
    })
    return () => sub.remove()
  }, [lastDeviceId, status, connect])

  useEffect(() => {
    return () => {
      stopScanRef.current?.()
      unsubLineRef.current?.()
      managerRef.current?.destroy()
    }
  }, [])

  return { status, state, found, lastDeviceId, scan, stopScan, connect, disconnect, forget }
}
