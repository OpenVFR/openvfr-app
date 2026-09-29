/**
 * useRoute — manages the current active route (waypoints, leg overrides).
 * Persists to AsyncStorage as 'current' route (same ID convention as web).
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import { emptyHistory, recordChange, undo as undoStep, redo as redoStep, type UndoHistory } from '@open-vfr/shared/undoHistory'
import { routes as db } from '../db'
import type { RouteDocType } from '../types/db'
import type { RouteWaypoint, LegOverride } from '../types/db'

const CURRENT_ID = 'current'

function blank(): RouteDocType {
  return { id: CURRENT_ID, name: 'Route', waypoints: [], legOverrides: [], updatedAt: Date.now() }
}

/** What undo/redo restores. Includes the saved-route link: loading a
 *  library route is two back-to-back calls (setWaypoints + setActiveRouteId,
 *  coalesced into one undo step), so undoing it must restore the previous
 *  route *and* its own link -- never leave restored waypoints linked to the
 *  wrong saved row (id-first save rule). */
interface RouteSnapshot {
  waypoints: RouteWaypoint[]
  legOverrides: LegOverride[]
  linkedRouteId: string | undefined
}
const snap = (r: RouteDocType): RouteSnapshot =>
  ({ waypoints: r.waypoints, legOverrides: r.legOverrides, linkedRouteId: r.linkedRouteId })

export function useRoute() {
  const [route, setRouteState] = useState<RouteDocType>(blank())
  const [loaded, setLoaded]    = useState(false)
  // Always the latest route, updated synchronously in persist() -- see below.
  const routeRef = useRef<RouteDocType>(route)
  const historyRef = useRef<UndoHistory<RouteSnapshot>>(emptyHistory())
  const [, setHistoryVersion] = useState(0)

  // ── Edit session ──────────────────────────────────────────────────────────
  // While armed (map planning mode), the first edit snapshots the route and
  // undo history; every later edit belongs to the same session until it is
  // applied (kept, as an unsaved working copy) or cancelled (snapshot
  // restored). Whole-route loads (library load, import) end a session.
  const sessionRef = useRef<{ snap: RouteSnapshot; history: UndoHistory<RouteSnapshot> } | null>(null)
  const sessionArmedRef = useRef(false)
  const [editSessionActive, setEditSessionActive] = useState(false)

  useEffect(() => {
    db.get(CURRENT_ID).then((stored) => {
      if (stored) { routeRef.current = stored; setRouteState(stored) }
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
  // Now evaluated eagerly against routeRef (kept in sync synchronously here,
  // so back-to-back calls still see each other's changes) instead of inside
  // a setState updater -- those may run twice (StrictMode), which would
  // double-record undo history and double-upsert.
  const persist = useCallback((updater: (prev: RouteDocType) => RouteDocType, recordUndo = true, wholeRoute = false) => {
    const prev = routeRef.current
    const next = updater(prev)
    if (next === prev) return
    const edited = next.waypoints !== prev.waypoints || next.legOverrides !== prev.legOverrides
      || next.linkedRouteId !== prev.linkedRouteId
    if (edited && recordUndo) {
      if (wholeRoute) {
        if (sessionRef.current) { sessionRef.current = null; setEditSessionActive(false) }
      } else if (sessionArmedRef.current && !sessionRef.current) {
        sessionRef.current = { snap: snap(prev), history: historyRef.current }
        setEditSessionActive(true)
      }
    }
    if (recordUndo && edited) {
      historyRef.current = recordChange(historyRef.current, snap(prev), Date.now())
      setHistoryVersion(v => v + 1)
    }
    routeRef.current = next
    void db.upsert(next)
    setRouteState(next)
  }, [])

  const applySnapshot = useCallback((s: RouteSnapshot) => {
    persist(prev => ({ ...prev, ...s, updatedAt: Date.now() }), false)
    setHistoryVersion(v => v + 1)
  }, [persist])

  const undo = useCallback(() => {
    const r = undoStep(historyRef.current, snap(routeRef.current))
    if (!r) return
    historyRef.current = r.history
    applySnapshot(r.state)
  }, [applySnapshot])

  const redo = useCallback(() => {
    const r = redoStep(historyRef.current, snap(routeRef.current))
    if (!r) return
    historyRef.current = r.history
    applySnapshot(r.state)
  }, [applySnapshot])

  /** Link (or unlink, with '') the working route to a saved routes-collection
   *  row. Persisted on the 'current' doc itself — same convention as web's
   *  useRouteDb.ts activeRouteId. */
  const setActiveRouteId = useCallback((id: string) => {
    persist(prev => ({ ...prev, linkedRouteId: id, updatedAt: Date.now() }), true, true)
  }, [persist])

  /** Arm/disarm automatic session start (map planning mode on/off). */
  const setEditSessionArmed = useCallback((armed: boolean) => { sessionArmedRef.current = armed }, [])
  /** Keep the session's changes. They stay an unsaved working copy. */
  const applyEditSession = useCallback(() => {
    sessionRef.current = null
    setEditSessionActive(false)
  }, [])
  /** Discard the session's changes: restore the route (and its undo history) as it was. */
  const cancelEditSession = useCallback(() => {
    const s = sessionRef.current
    if (!s) return
    sessionRef.current = null
    setEditSessionActive(false)
    historyRef.current = s.history
    persist(prev => ({ ...prev, ...s.snap, updatedAt: Date.now() }), false)
    setHistoryVersion(v => v + 1)
  }, [persist])

  const addWaypoint = useCallback((wp: RouteWaypoint) => {
    persist(prev => ({ ...prev, waypoints: [...prev.waypoints, wp], updatedAt: Date.now() }))
  }, [persist])

  const [routeVisible, setRouteVisibleRaw] = useState(true)
  const routeVisibleRef = useRef(true)
  const setRouteVisible = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === 'function' ? v(routeVisibleRef.current) : v
    routeVisibleRef.current = next
    setRouteVisibleRaw(next)
    if (next) setRouteFitNonce(n => n + 1)
  }, [])

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

  // Bumped whenever a whole route is loaded or re-shown; the map fits its
  // camera to the route on each change (see AviationMap).
  const [routeFitNonce, setRouteFitNonce] = useState(0)
  const setWaypoints = useCallback((wps: RouteWaypoint[], overrides?: LegOverride[]) => {
    setRouteFitNonce(n => n + 1)
    persist(prev => ({ ...prev, waypoints: wps, legOverrides: overrides ?? prev.legOverrides, updatedAt: Date.now() }), true, true)
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
           moveWaypoint, reverseRoute, setLegOverride, setWaypointNote,
           undo, redo,
           canUndo: historyRef.current.past.length > 0,
           canRedo: historyRef.current.future.length > 0,
           clearRoute, setWaypoints, loaded,
           // Route activate/deactivate — hides the drawn route on the map without
           // touching stored waypoints. Purely a display toggle, not persisted.
           routeVisible, setRouteVisible,
           // Saved-route link — id of the routes-collection row the working
           // route was loaded from ('' = untitled/unlinked). See setActiveRouteId above.
           activeRouteId: route.linkedRouteId ?? '', setActiveRouteId, routeFitNonce,
           editSessionActive, setEditSessionArmed, applyEditSession, cancelEditSession }
}
