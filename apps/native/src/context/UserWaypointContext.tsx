/**
 * UserWaypointContext — shares one useUserWaypointSync instance between
 * MapScreen (save-on-long-press) and PlanScreen (Waypoints segment list),
 * so both see the same synced list and neither runs a duplicate login-pull.
 */

import React, { createContext, useContext, ReactNode } from 'react'
import { useUserWaypointSync } from '../hooks/useUserWaypointSync'
import { useAuthContext } from './AuthContext'

type UserWaypointContextValue = ReturnType<typeof useUserWaypointSync>

const UserWaypointContext = createContext<UserWaypointContextValue | null>(null)

export function UserWaypointProvider({ children }: { children: ReactNode }) {
  const { state } = useAuthContext()
  const sync = useUserWaypointSync(state.status === 'authenticated')
  return <UserWaypointContext.Provider value={sync}>{children}</UserWaypointContext.Provider>
}

export function useUserWaypointContext(): UserWaypointContextValue {
  const ctx = useContext(UserWaypointContext)
  if (!ctx) throw new Error('useUserWaypointContext must be used inside <UserWaypointProvider>')
  return ctx
}
