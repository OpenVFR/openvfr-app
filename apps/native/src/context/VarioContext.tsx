import React, { createContext, useContext, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { useBlueFlyVario } from '../hooks/useBlueFlyVario'
import { useSettingsContext } from './SettingsContext'

type VarioContextValue = ReturnType<typeof useBlueFlyVario> & {
  /** Publish the live auto-derived QNH (METAR / field calibration), or null to
   *  fall back to the stored setting. Ignored while QNH is set to manual. */
  setLiveQnh: (hpa: number | null) => void
}

const VarioContext = createContext<VarioContextValue | null>(null)

export function VarioProvider({ children }: { children: ReactNode }) {
  const { settings, update, loaded } = useSettingsContext()
  // Live-updating ref so useBlueFlyVario's line handler always uses the
  // current QNH without needing to resubscribe/recreate the BLE manager
  // whenever the setting changes. In auto mode it follows the live
  // METAR/field-derived QNH (published via setLiveQnh) so the vario altitude
  // agrees with the phone-barometer altitude; otherwise the stored value.
  const settingsQnhRef = useRef(settings.qnhHpa)
  const qnhAutoRef     = useRef(settings.qnhAuto)
  const liveQnhRef     = useRef<number | null>(null)
  settingsQnhRef.current = settings.qnhHpa
  qnhAutoRef.current     = settings.qnhAuto
  const qnhHpaRef = useMemo(() => ({
    get current(): number {
      return qnhAutoRef.current && liveQnhRef.current != null ? liveQnhRef.current : settingsQnhRef.current
    },
  }), [])
  const setLiveQnh = useCallback((hpa: number | null) => { liveQnhRef.current = hpa }, [])

  const handleDeviceIdChange = useCallback((id: string) => {
    update({ varioAutoConnectId: id })
  }, [update])

  // Only pass a real initialDeviceId once persisted settings have actually
  // loaded from AsyncStorage — before that, settings.varioAutoConnectId is
  // just the in-memory DEFAULTS value ('') and would otherwise "win" the
  // hook's one-shot auto-connect-attempt guard before the real persisted
  // value arrives a moment later.
  const vario = useBlueFlyVario(qnhHpaRef, {
    initialDeviceId: loaded ? settings.varioAutoConnectId : undefined,
    onDeviceIdChange: handleDeviceIdChange,
  })
  return <VarioContext.Provider value={{ ...vario, setLiveQnh }}>{children}</VarioContext.Provider>
}

export function useVarioContext(): VarioContextValue {
  const ctx = useContext(VarioContext)
  if (!ctx) throw new Error('useVarioContext must be used inside <VarioProvider>')
  return ctx
}
