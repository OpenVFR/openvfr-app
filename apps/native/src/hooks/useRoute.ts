/**
 * useRoute — manages the current active route (waypoints, leg overrides).
 * Persists to AsyncStorage as 'current' route (same ID convention as web).
 */

import { useEffect, useState, useCallback } from 'react'
import { routes as db } from '../db'
import type { RouteDocType } from '../types/db'
import type { RouteWaypoint, LegOverride } from '../types/db'

const CURRENT_ID = 'current'

function blank(): RouteDocType {
  return { id: CURRENT_ID, name: 'Route', waypoints: [], legOverrides: [], updatedAt: Date.now() }
}

export function useRoute() {
  const [route, setRouteState] = useState<RouteDocType>(blank())
  const [loaded, setLoaded]    = useState(false)

  useEffect(() => {
    db.get(CURRENT_ID).then((stored) => {
      if (stored) setRouteState(stored)
      setLoaded(true)
    })
  }, [])

  const persist = useCallback(async (next: RouteDocType) => {
    setRouteState(next)
    await db.upsert(next)
  }, [])

  /** Link (or unlink, with '') the working route to a saved routes-collection
   *  row. Persisted on the 'current' doc itself — same convention as web's
   *  useRouteDb.ts activeRouteId. */
  const setActiveRouteId = useCallback((id: string) => {
    persist({ ...route, linkedRouteId: id, updatedAt: Date.now() })
  }, [route, persist])

  const addWaypoint = useCallback((wp: RouteWaypoint) => {
    persist({ ...route, waypoints: [...route.waypoints, wp], updatedAt: Date.now() })
  }, [route, persist])

  const [routeVisible, setRouteVisible] = useState(true)

  const removeWaypoint = useCallback((index: number) => {
    const wps = route.waypoints.filter((_, i) => i !== index)
    const ovr = route.legOverrides.filter((_, i) => i !== index)
    persist({ ...route, waypoints: wps, legOverrides: ovr, updatedAt: Date.now() })
  }, [route, persist])

  const clearRoute = useCallback(() => {
    // New Route — also unlinks from whatever saved route was active, same as
    // web's requestNew()/onActiveRouteIdChange('') pairing.
    persist({ ...blank(), updatedAt: Date.now() })
  }, [persist])

  const setWaypoints = useCallback((wps: RouteWaypoint[], overrides?: LegOverride[]) => {
    persist({ ...route, waypoints: wps, legOverrides: overrides ?? route.legOverrides, updatedAt: Date.now() })
  }, [route, persist])

  const insertWaypoint = useCallback((afterIndex: number, wp: RouteWaypoint) => {
    const wps = [...route.waypoints]
    wps.splice(afterIndex + 1, 0, wp)
    const ovr = [...route.legOverrides]
    ovr.splice(afterIndex + 1, 0, {})
    persist({ ...route, waypoints: wps, legOverrides: ovr, updatedAt: Date.now() })
  }, [route, persist])

  const updateWaypoint = useCallback((index: number, pos: { lat: number; lng: number }) => {
    const wps = route.waypoints.map((w, i) =>
      i === index ? { ...w, lat: pos.lat, lng: pos.lng } : w
    )
    persist({ ...route, waypoints: wps, updatedAt: Date.now() })
  }, [route, persist])

  /** Move the waypoint at `from` to position `to` — sidebar drag/reorder. */
  const moveWaypoint = useCallback((from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= route.waypoints.length || to >= route.waypoints.length) return
    const wps = [...route.waypoints]
    const [item] = wps.splice(from, 1)
    wps.splice(to, 0, item)
    persist({ ...route, waypoints: wps, updatedAt: Date.now() })
  }, [route, persist])

  /** Reverse the whole route — mirrors web's Reverse action. Leg overrides are
   *  NOT remapped (same limitation as web — they stay indexed to the old leg
   *  positions), so they're cleared to avoid applying a stale override to the
   *  wrong leg. */
  const reverseRoute = useCallback(() => {
    persist({ ...route, waypoints: [...route.waypoints].reverse(), legOverrides: [], updatedAt: Date.now() })
  }, [route, persist])

  /** Remove the last waypoint — mirrors web's Undo button. */
  const undoLast = useCallback(() => {
    if (route.waypoints.length === 0) return
    persist({
      ...route,
      waypoints: route.waypoints.slice(0, -1),
      legOverrides: route.legOverrides.slice(0, -1),
      updatedAt: Date.now(),
    })
  }, [route, persist])

  const setLegOverride = useCallback((idx: number, override: LegOverride) => {
    const ovr = [...route.legOverrides]
    ovr[idx] = override
    persist({ ...route, legOverrides: ovr, updatedAt: Date.now() })
  }, [route, persist])

  const setWaypointNote = useCallback((wpIdx: number, note: string) => {
    const wps = route.waypoints.map((w, i) => i === wpIdx ? { ...w, note: note || undefined } : w)
    persist({ ...route, waypoints: wps, updatedAt: Date.now() })
  }, [route, persist])

  return { route, waypoints: route.waypoints, legOverrides: route.legOverrides,
           addWaypoint, removeWaypoint, insertWaypoint, updateWaypoint,
           moveWaypoint, reverseRoute, undoLast, setLegOverride, setWaypointNote,
           clearRoute, setWaypoints, loaded,
           // Route activate/deactivate — hides the drawn route on the map without
           // touching stored waypoints. Purely a display toggle, not persisted.
           routeVisible, setRouteVisible,
           // Saved-route link — id of the routes-collection row the working
           // route was loaded from ('' = untitled/unlinked). See setActiveRouteId above.
           activeRouteId: route.linkedRouteId ?? '', setActiveRouteId }
}
