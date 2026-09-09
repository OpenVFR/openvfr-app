import React, { createContext, useContext, ReactNode } from 'react'
import { useRoute } from '../hooks/useRoute'

type RouteContextValue = ReturnType<typeof useRoute>

const RouteContext = createContext<RouteContextValue | null>(null)

export function RouteProvider({ children }: { children: ReactNode }) {
  const route = useRoute()
  return <RouteContext.Provider value={route}>{children}</RouteContext.Provider>
}

export function useRouteContext(): RouteContextValue {
  const ctx = useContext(RouteContext)
  if (!ctx) throw new Error('useRouteContext must be used inside <RouteProvider>')
  return ctx
}
