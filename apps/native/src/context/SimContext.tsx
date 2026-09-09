import React, { createContext, useContext, ReactNode } from 'react'
import { useSimInput } from '../hooks/useSimInput'

type SimContextValue = ReturnType<typeof useSimInput>

const SimContext = createContext<SimContextValue | null>(null)

export function SimProvider({ children }: { children: ReactNode }) {
  const sim = useSimInput()
  return <SimContext.Provider value={sim}>{children}</SimContext.Provider>
}

export function useSimContext(): SimContextValue {
  const ctx = useContext(SimContext)
  if (!ctx) throw new Error('useSimContext must be used inside <SimProvider>')
  return ctx
}
