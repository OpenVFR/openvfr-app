import React, { createContext, useContext, useEffect, ReactNode } from 'react'
import { useSettings } from '../hooks/useSettings'
import { setActiveThemeName } from '../styles/theme'

type SettingsContextValue = ReturnType<typeof useSettings>

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const settings = useSettings()

  // Mirror the persisted theme setting into styles/theme.ts's mutable
  // singleton the moment it loads or changes — see that file's header for
  // why this doesn't need a re-render of this provider itself.
  useEffect(() => {
    if (settings.loaded) setActiveThemeName(settings.settings.theme)
  }, [settings.loaded, settings.settings.theme])

  return <SettingsContext.Provider value={settings}>{children}</SettingsContext.Provider>
}

export function useSettingsContext(): SettingsContextValue {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettingsContext must be used inside <SettingsProvider>')
  return ctx
}
