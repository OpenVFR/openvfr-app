/**
 * MapFocusContext — lets other screens (e.g. the Plan screen's saved places)
 * ask the map to centre on a point. MapScreen consumes `request` and flies
 * there; `nonce` makes a repeat request for the same point still fire.
 */

import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react'

export interface MapFocusRequest { lat: number; lng: number; zoom?: number; nonce: number }

interface MapFocusValue {
  request: MapFocusRequest | null
  focusMap: (lat: number, lng: number, zoom?: number) => void
}

const MapFocusContext = createContext<MapFocusValue | null>(null)

export function MapFocusProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<MapFocusRequest | null>(null)
  const focusMap = useCallback((lat: number, lng: number, zoom?: number) => {
    setRequest({ lat, lng, zoom, nonce: Date.now() })
  }, [])
  return <MapFocusContext.Provider value={{ request, focusMap }}>{children}</MapFocusContext.Provider>
}

export function useMapFocus(): MapFocusValue {
  const ctx = useContext(MapFocusContext)
  if (!ctx) throw new Error('useMapFocus must be used inside <MapFocusProvider>')
  return ctx
}
