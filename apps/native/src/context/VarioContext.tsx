import React, { createContext, useContext, useCallback, useRef, type ReactNode } from 'react'
import { useBlueFlyVario } from '../hooks/useBlueFlyVario'
import { useSettingsContext } from './SettingsContext'

type VarioContextValue = ReturnType<typeof useBlueFlyVario>

const VarioContext = createContext<VarioContextValue | null>(null)

export function VarioProvider({ children }: { children: ReactNode }) {
  const { settings, update, loaded } = useSettingsContext()
  // Live-updating ref so useBlueFlyVario's line handler always uses the
  // current QNH without needing to resubscribe/recreate the BLE manager
  // whenever the setting changes.
  const qnhHpaRef = useRef(settings.qnhHpa)
  qnhHpaRef.current = settings.qnhHpa

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
  return <VarioContext.Provider value={vario}>{children}</VarioContext.Provider>
}

export function useVarioContext(): VarioContextValue {
  const ctx = useContext(VarioContext)
  if (!ctx) throw new Error('useVarioContext must be used inside <VarioProvider>')
  return ctx
}
