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

  // `persist` takes an updater over the *latest* state (functional setState),
  // not a plain next-object built from the `route` closure — mutators below
  // (setWaypoints, setActiveRouteId, ...) are often called back-to-back
  // synchronously from the same event handler (see RouteLibrarySheet's
  // handleLoad: onLoad() then onActiveRouteIdChange(), both in one tap),
  // before either state update has re-rendered. Two mutators built from the
  // same stale `route` closure would each spread the SAME pre-update object —
  // the second call's persist() would silently clobber the first's change
  // (e.g. a freshly-loaded 9-waypoint route reverted to 0 waypoints because
  // setActiveRouteId's closure still saw the old blank route). Functional
  // setRouteState always applies against React's latest queued state.
  const persist = useCallback((updater: (prev: RouteDocType) => RouteDocType) => {
    setRouteState(prev => {
      const next = updater(prev)
      void db.upsert(next)
      return next
    })
  }, [])

  /** Link (or unlink, with '') the working route to a saved routes-collection
   *  row. Persisted on the 'current' doc itself — same convention as web's
   *  useRouteDb.ts activeRouteId. */
  const setActiveRouteId = useCallback((id: string) => {
    persist(prev => ({ ...prev, linkedRouteId: id, updatedAt: Date.now() }))
  }, [persist])

  const addWaypoint = useCallback((wp: RouteWaypoint) => {
    persist(prev => ({ ...prev, waypoints: [...prev.waypoints, wp], updatedAt: Date.now() }))
  }, [persist])

  const [routeVisible, setRouteVisible] = useState(true)

  const removeWaypoint = useCallback((index: number) => {
    persist(prev => ({
      ...prev,
      waypoints: prev.waypoints.filter((_, i) => i !== index),
      legOverrides: prev.legOverrides.filter((_, i) => i !== index),
      updatedAt: Date.now(),
    }))
  }, [persist])

  const clearRoute = useCallback(() => {
    // New Route — also unlinks from whatever saved route was active, same as
    // web's requestNew()/onActiveRouteIdChange('') pairing.
    persist(() => ({ ...blank(), updatedAt: Date.now() }))
  }, [persist])

  const setWaypoints = useCallback((wps: RouteWaypoint[], overrides?: LegOverride[]) => {
    persist(prev => ({ ...prev, waypoints: wps, legOverrides: overrides ?? prev.legOverrides, updatedAt: Date.now() }))
  }, [persist])

  const insertWaypoint = useCallback((afterIndex: number, wp: RouteWaypoint) => {
    persist(prev => {
      const wps = [...prev.waypoints]
      wps.splice(afterIndex + 1, 0, wp)
      const ovr = [...prev.legOverrides]
      ovr.splice(afterIndex + 1, 0, {})
      return { ...prev, waypoints: wps, legOverrides: ovr, updatedAt: Date.now() }
    })
  }, [persist])

  const updateWaypoint = useCallback((index: number, pos: { lat: number; lng: number }) => {
    persist(prev => ({
      ...prev,
      waypoints: prev.waypoints.map((w, i) => i === index ? { ...w, lat: pos.lat, lng: pos.lng } : w),
      updatedAt: Date.now(),
    }))
  }, [persist])

  /** Move the waypoint at `from` to position `to` — sidebar drag/reorder. */
  const moveWaypoint = useCallback((from: number, to: number) => {
    persist(prev => {
      if (from === to || from < 0 || to < 0 || from >= prev.waypoints.length || to >= prev.waypoints.length) return prev
      const wps = [...prev.waypoints]
      const [item] = wps.splice(from, 1)
      wps.splice(to, 0, item)
      return { ...prev, waypoints: wps, updatedAt: Date.now() }
    })
  }, [persist])

  /** Reverse the whole route — mirrors web's Reverse action. Leg overrides are
   *  NOT remapped (same limitation as web — they stay indexed to the old leg
   *  positions), so they're cleared to avoid applying a stale override to the
   *  wrong leg. */
  const reverseRoute = useCallback(() => {
    persist(prev => ({ ...prev, waypoints: [...prev.waypoints].reverse(), legOverrides: [], updatedAt: Date.now() }))
  }, [persist])

  /** Remove the last waypoint — mirrors web's Undo button. */
  const undoLast = useCallback(() => {
    persist(prev => {
      if (prev.waypoints.length === 0) return prev
      return {
        ...prev,
        waypoints: prev.waypoints.slice(0, -1),
        legOverrides: prev.legOverrides.slice(0, -1),
        updatedAt: Date.now(),
      }
    })
  }, [persist])

  const setLegOverride = useCallback((idx: number, override: LegOverride) => {
    persist(prev => {
      const ovr = [...prev.legOverrides]
      ovr[idx] = override
      return { ...prev, legOverrides: ovr, updatedAt: Date.now() }
    })
  }, [persist])

  const setWaypointNote = useCallback((wpIdx: number, note: string) => {
    persist(prev => ({
      ...prev,
      waypoints: prev.waypoints.map((w, i) => i === wpIdx ? { ...w, note: note || undefined } : w),
      updatedAt: Date.now(),
    }))
  }, [persist])

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
