/**
 * AuthContext — single shared auth state for the whole app.
 *
 * Wrap the root with <AuthProvider> and call useAuthContext() anywhere
 * instead of useAuth() directly. This avoids two separate useAuth()
 * instances (App + LoginScreen) having independent state.
 */

import React, { createContext, useContext, ReactNode } from 'react'
import { useAuth } from '../hooks/useAuth'

type AuthContextValue = ReturnType<typeof useAuth>

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
}

export function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuthContext must be used inside <AuthProvider>')
  return ctx
}
