/**
 * FlightLogViewContext — shares "which completed flight log is currently
 * being viewed on the map" between PlanScreen's Logs segment (where a log
 * is selected via a View button) and MapScreen (which renders the track as
 * a line + fits the camera to its bounds). Mirrors UserWaypointContext's
 * shape (thin context wrapping shared state, not a sync hook here since
 * flight log data itself is already owned by useFlightLogSync).
 */

import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import type { FlightLogDocType, TrackPoint } from '../types/db'

interface FlightLogViewValue {
  /** The log currently selected for map viewing, or null if none. */
  selectedLog: FlightLogDocType | null
  /** Parsed track points for the selected log (empty if none/unparseable). */
  selectedTrack: TrackPoint[]
  /** Select a log to view (or pass null to clear/hide it). */
  viewLog: (log: FlightLogDocType | null) => void
  /** Clear the current selection (equivalent to viewLog(null)). */
  clearView: () => void
}

const FlightLogViewContext = createContext<FlightLogViewValue | null>(null)

export function FlightLogViewProvider({ children }: { children: ReactNode }) {
  const [selectedLog, setSelectedLog]     = useState<FlightLogDocType | null>(null)
  const [selectedTrack, setSelectedTrack] = useState<TrackPoint[]>([])

  const viewLog = useCallback((log: FlightLogDocType | null) => {
    setSelectedLog(log)
    if (!log) { setSelectedTrack([]); return }
    try {
      setSelectedTrack(JSON.parse(log.trackJson) as TrackPoint[])
    } catch {
      setSelectedTrack([])
    }
  }, [])

  const clearView = useCallback(() => viewLog(null), [viewLog])

  return (
    <FlightLogViewContext.Provider value={{ selectedLog, selectedTrack, viewLog, clearView }}>
      {children}
    </FlightLogViewContext.Provider>
  )
}

export function useFlightLogViewContext(): FlightLogViewValue {
  const ctx = useContext(FlightLogViewContext)
  if (!ctx) throw new Error('useFlightLogViewContext must be used inside <FlightLogViewProvider>')
  return ctx
}
