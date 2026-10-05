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
import { qnhStepNeedsReset } from '@open-vfr/shared/qnhResolve'
import { isVarioFresh } from '@open-vfr/shared/baroAltitude'
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
  const unsubDiscRef = useRef<(() => void) | null>(null)
  const triedInitialRef = useRef(false)
  // One Kalman filter instance per connection — reset on each fresh connect
  // so a stale velocity estimate from a previous session never leaks in.
  // Runs on $BFX/$LK8EX1's own pressurePa field (not their vario/vario_cms
  // field — see BlueFlyBleManager's OUTPUT_MODE_BFX comment for why).
  const kalmanRef = useRef(new BaroKalmanFilter({ dt: BFX_SAMPLE_DT_S }))
  // A QNH change shifts the computed altitude in one step, which the filter
  // would read as a climb/descent. Restart it instead so VS doesn't spike.
  const lastQnhRef = useRef<number | null>(null)
  const lastSampleAtRef = useRef(0)
  const qnhForSample = useCallback((): number => {
    const q = qnhHpaRef.current
    if (qnhStepNeedsReset(lastQnhRef.current, q)) kalmanRef.current.reset()
    // The filter assumes a fixed sample interval: after a data gap its
    // velocity estimate is stale, so restart rather than spike VS on resume.
    const now = Date.now()
    if (lastSampleAtRef.current && !isVarioFresh(lastSampleAtRef.current, now)) kalmanRef.current.reset()
    lastSampleAtRef.current = now
    lastQnhRef.current = q
    return q
  }, [qnhHpaRef])

  const getManager = useCallback(() => {
    if (!managerRef.current) managerRef.current = new BlueFlyBleManager()
    return managerRef.current
  }, [])

  const handleLine = useCallback((line: string) => {
    if (!validateChecksum(line)) return

    const bfx = parseBfx(line)
    if (bfx) {
      const { altitudeM, verticalMs } = kalmanRef.current.update(bfx.pressurePa, qnhForSample())
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
      const { altitudeM, verticalMs } = kalmanRef.current.update(lk.pressurePa, qnhForSample())
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
  }, [qnhForSample])

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

  // ── Link-loss recovery ────────────────────────────────────────────────
  // Moving/powering the vario drops the BLE link; Android's autoConnect
  // restores the raw link but not our notification subscription, so telemetry
  // would stay dead while status still said 'connected'. Reconnect with
  // backoff until the pilot disconnects/forgets.
  const userStoppedRef   = useRef(true)
  const reconnectTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptRef       = useRef(0)
  const connectRef       = useRef<(id: string) => Promise<void>>(async () => {})
  const lastIdRef        = useRef<string | null>(null)

  const scheduleReconnect = useCallback(() => {
    if (userStoppedRef.current || !lastIdRef.current) return
    if (reconnectTimer.current) return
    console.log('[vario] link lost -> reconnect attempt', attemptRef.current + 1)
    setState(null)
    setStatus('connecting')
    const delay = Math.min(2_000 * 2 ** attemptRef.current, 15_000)
    attemptRef.current += 1
    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null
      if (userStoppedRef.current || !lastIdRef.current) return
      console.log('[vario] reconnecting to', lastIdRef.current)
      connectRef.current(lastIdRef.current).catch(() => {})
    }, delay)
  }, [])

  const connect = useCallback(async (deviceId: string) => {
    stopScan()
    userStoppedRef.current = false
    lastIdRef.current = deviceId
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
      unsubDiscRef.current?.()
      unsubDiscRef.current = manager.onDisconnected(scheduleReconnect)
      lastSampleAtRef.current = Date.now()
      attemptRef.current = 0
      setLastDeviceId(deviceId)
      onDeviceIdChange?.(deviceId)
      console.log('[vario] connected')
      setStatus('connected')
    } catch (e) {
      console.log('[vario] connect failed:', String((e as Error)?.message ?? e))
      if (attemptRef.current > 0 && !userStoppedRef.current) { setStatus('connecting'); scheduleReconnect() }
      else setStatus('error')
    }
  }, [getManager, handleLine, stopScan, onDeviceIdChange, scheduleReconnect])
  connectRef.current = connect

  // Watchdog: link claims to be up but no samples for 10 s (silently dead
  // subscription) → tear down and reconnect.
  useEffect(() => {
    if (status !== 'connected') return
    const id = setInterval(() => {
      const last = lastSampleAtRef.current
      if (last && Date.now() - last > 10_000) { console.log('[vario] watchdog: no samples 10s'); scheduleReconnect() }
    }, 2_000)
    return () => clearInterval(id)
  }, [status, scheduleReconnect])

  const disconnect = useCallback(() => {
    userStoppedRef.current = true
    if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null }
    unsubDiscRef.current?.()
    unsubDiscRef.current = null
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
      userStoppedRef.current = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      stopScanRef.current?.()
      unsubDiscRef.current?.()
      unsubLineRef.current?.()
      managerRef.current?.destroy()
    }
  }, [])

  return { status, state, found, lastDeviceId, scan, stopScan, connect, disconnect, forget }
}
