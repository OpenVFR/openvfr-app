/**
 * TabBarContext -- collapsed/expanded state of the bottom tab bar.
 *
 * Shared between the tab bar itself (swipe/tap handle) and screens that need
 * to drive it (MapScreen collapses it when a flight mode starts, so the map
 * gets the full height in the air). Kept separate from settings on purpose:
 * it is transient UI state, not something to persist across launches.
 */
import React, { createContext, useContext, useMemo, useState } from 'react'

interface TabBarValue {
  collapsed:    boolean
  setCollapsed: (collapsed: boolean) => void
}

const TabBarContext = createContext<TabBarValue | null>(null)

export function TabBarProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false)
  const value = useMemo(() => ({ collapsed, setCollapsed }), [collapsed])
  return <TabBarContext.Provider value={value}>{children}</TabBarContext.Provider>
}

export function useTabBarCollapsed(): TabBarValue {
  const ctx = useContext(TabBarContext)
  if (!ctx) throw new Error('useTabBarCollapsed must be used inside <TabBarProvider>')
  return ctx
}
