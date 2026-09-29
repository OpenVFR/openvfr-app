import { useState, useEffect, useCallback, useRef } from 'react'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { LegOverride, RouteDocType } from './index'
import { getDb } from './index'
import { resolveSaveRouteId } from '@open-vfr/shared/resolveSaveRouteId'
import { emptyHistory, recordChange, undo as undoStep, redo as redoStep, type UndoHistory } from '@open-vfr/shared/undoHistory'

const ROUTE_ID = 'current'
const LS_KEY   = 'openvfr.route'

type WaypointSetter = (updater: RouteWaypoint[] | ((prev: RouteWaypoint[]) => RouteWaypoint[])) => void
type OverrideSetter = (updater: LegOverride[]  | ((prev: LegOverride[])  => LegOverride[]))  => void

interface RouteSnapshot { waypoints: RouteWaypoint[]; legOverrides: LegOverride[] }

/** Undo/redo for edits to the working route. History is cleared whenever a
 *  different route is loaded, so undo never crosses into another route
 *  (which would also desync the saved-route id link). */
export interface RouteUndo {
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  /** Edit session: opens on the first edit while armed (planning / adjust mode),
   *  stays open for every later edit, ends on apply (keep, unsaved) or cancel
   *  (restore the route and history from before the first edit). */
  editSessionActive: boolean
  setEditSessionArmed: (armed: boolean) => void
  applyEditSession: () => void
  cancelEditSession: () => void
}

/**
 * Persistent route hook backed by RxDB/IndexedDB.
 * Returns [waypoints, setWaypoints, legOverrides, setLegOverrides, loadRoute,
 * aircraftId, setAircraftId, activeRouteId, setActiveRouteId].
 * Drops in as a replacement for useState; migrates from localStorage on first use.
 */
export function usePersistedRoute(): [
  RouteWaypoint[], WaypointSetter, LegOverride[], OverrideSetter,
  (wps: RouteWaypoint[], ovr: LegOverride[], aircraftId?: string, routeId?: string) => void,
  string, (id: string) => void,
  string, (id: string) => void,
  RouteUndo,
] {
  const [waypoints, setWaypointsState]       = useState<RouteWaypoint[]>([])
  const [legOverrides, setLegOverridesState] = useState<LegOverride[]>([])
  const [aircraftId, setAircraftIdState]     = useState<string>('')
  // Id of the saved route (routes collection row) the working route was
  // loaded from, or '' if untitled/not linked to any saved row. Lets the
  // Route Library's "Save" button update that same row instead of matching
  // by name — see RouteLibrary.tsx's Save/Save As split.
  const [activeRouteId, setActiveRouteIdState] = useState<string>('')

  // Refs always mirror the latest state so persist callbacks never close over stale values.
  const waypointsRef     = useRef<RouteWaypoint[]>([])
  const legOverridesRef  = useRef<LegOverride[]>([])
  const aircraftIdRef    = useRef<string>('')
  const activeRouteIdRef = useRef<string>('')
  waypointsRef.current     = waypoints
  legOverridesRef.current  = legOverrides
  aircraftIdRef.current    = aircraftId
  activeRouteIdRef.current = activeRouteId

  // Undo history lives in a ref (updated synchronously alongside the route
  // refs); `historyVersion` only exists to re-render canUndo/canRedo.
  const historyRef = useRef<UndoHistory<RouteSnapshot>>(emptyHistory())
  const [, setHistoryVersion] = useState(0)

  // Edit session (see RouteUndo): snapshot of the route + history at the
  // first armed edit.
  const sessionRef = useRef<{ snap: RouteSnapshot; history: UndoHistory<RouteSnapshot> } | null>(null)
  const sessionArmedRef = useRef(false)
  const [editSessionActive, setEditSessionActive] = useState(false)

  const recordHistory = useCallback(() => {
    if (sessionArmedRef.current && !sessionRef.current) {
      sessionRef.current = {
        snap: { waypoints: waypointsRef.current, legOverrides: legOverridesRef.current },
        history: historyRef.current,
      }
      setEditSessionActive(true)
    }
    historyRef.current = recordChange(historyRef.current,
      { waypoints: waypointsRef.current, legOverrides: legOverridesRef.current }, Date.now())
    setHistoryVersion(v => v + 1)
  }, [])

  // Load once on mount; migrate from localStorage if RxDB has no saved route yet.
  useEffect(() => {
    getDb().then(async (db) => {
      const doc = await db.routes.findOne(ROUTE_ID).exec()
      if (doc) {
        setWaypointsState([...doc.waypoints] as RouteWaypoint[])
        setLegOverridesState([...(doc.legOverrides ?? [])] as LegOverride[])
        setAircraftIdState(doc.aircraftId ?? '')
        setActiveRouteIdState(doc.linkedRouteId ?? '')
        localStorage.removeItem(LS_KEY)
      } else {
        // Migrate existing localStorage route to RxDB.
        try {
          const raw = localStorage.getItem(LS_KEY)
          if (raw) {
            const wps = JSON.parse(raw) as RouteWaypoint[]
            if (Array.isArray(wps) && wps.length > 0) {
              await db.routes.upsert({
                id: ROUTE_ID, name: 'Current Route', waypoints: wps, legOverrides: [], aircraftId: '', updatedAt: Date.now(),
              })
              setWaypointsState(wps)
            }
            localStorage.removeItem(LS_KEY)
          }
        } catch {
          // Ignore malformed localStorage data.
        }
      }
    }).catch(() => {
      // IndexedDB unavailable — fall back to plain in-memory route.
      try {
        const raw = localStorage.getItem(LS_KEY)
        if (raw) setWaypointsState(JSON.parse(raw) as RouteWaypoint[])
      } catch { /* ignore */ }
    })
  }, [])

  const persist = useCallback((wps: RouteWaypoint[], ovr: LegOverride[], acId?: string, routeId?: string) => {
    getDb().then((db) =>
      db.routes.upsert({
        id: ROUTE_ID, name: 'Current Route', waypoints: wps, legOverrides: ovr,
        aircraftId: acId ?? aircraftIdRef.current,
        linkedRouteId: routeId ?? activeRouteIdRef.current,
        updatedAt: Date.now(),
      })
    ).catch(console.error)
  }, [])

  // The updater is applied eagerly against the refs (always the latest
  // value -- they're updated synchronously below), not inside a React state
  // updater: those run twice under StrictMode, which would double-record
  // undo history and double-persist.
  const setWaypoints = useCallback<WaypointSetter>((updater) => {
    const prev = waypointsRef.current
    const next = typeof updater === 'function' ? updater(prev) : updater
    if (next === prev) return
    recordHistory()
    // Trim overrides to at most (next.length - 1) entries when waypoints shrink.
    const trimmed = legOverridesRef.current.slice(0, Math.max(0, next.length - 1))
    // Update refs synchronously so a setLegOverrides call in the same event
    // handler (e.g. delete-waypoint handlers that call both setters back to
    // back) doesn't persist() with a stale pre-update value — refs otherwise
    // only update on next render, causing the later persist() to overwrite
    // IndexedDB with the old array.
    waypointsRef.current    = next
    legOverridesRef.current = trimmed
    setWaypointsState(next)
    setLegOverridesState(trimmed)
    persist(next, trimmed)
  }, [persist, recordHistory])

  const setLegOverrides = useCallback<OverrideSetter>((updater) => {
    const prev = legOverridesRef.current
    const next = typeof updater === 'function' ? updater(prev) : updater
    if (next === prev) return
    recordHistory()
    legOverridesRef.current = next
    setLegOverridesState(next)
    persist(waypointsRef.current, next)
  }, [persist, recordHistory])

  const applySnapshot = useCallback((snap: RouteSnapshot) => {
    waypointsRef.current    = snap.waypoints
    legOverridesRef.current = snap.legOverrides
    setWaypointsState(snap.waypoints)
    setLegOverridesState(snap.legOverrides)
    persist(snap.waypoints, snap.legOverrides)
    setHistoryVersion(v => v + 1)
  }, [persist])

  const undo = useCallback(() => {
    const r = undoStep(historyRef.current, { waypoints: waypointsRef.current, legOverrides: legOverridesRef.current })
    if (!r) return
    historyRef.current = r.history
    applySnapshot(r.state)
  }, [applySnapshot])

  const redo = useCallback(() => {
    const r = redoStep(historyRef.current, { waypoints: waypointsRef.current, legOverrides: legOverridesRef.current })
    if (!r) return
    historyRef.current = r.history
    applySnapshot(r.state)
  }, [applySnapshot])

  /**
   * Atomically replace both waypoints and leg overrides (used by Route
   * Library load). `routeId` links the working route to the saved row it
   * came from — omit (or pass '') for an untitled/new route.
   */
  const loadRoute = useCallback((wps: RouteWaypoint[], ovr: LegOverride[], acId?: string, routeId?: string) => {
    const safeOvr = ovr.slice(0, Math.max(0, wps.length - 1))
    const nextAcId = acId ?? ''
    const nextRouteId = routeId ?? ''
    waypointsRef.current     = wps
    legOverridesRef.current  = safeOvr
    aircraftIdRef.current    = nextAcId
    activeRouteIdRef.current = nextRouteId
    setWaypointsState(wps)
    setLegOverridesState(safeOvr)
    setAircraftIdState(nextAcId)
    setActiveRouteIdState(nextRouteId)
    persist(wps, safeOvr, nextAcId, nextRouteId)
    sessionRef.current = null
    setEditSessionActive(false)
    historyRef.current = emptyHistory()
    setHistoryVersion(v => v + 1)
  }, [persist])

  /** Set the aircraft profile associated with the current working route. */
  const setAircraftId = useCallback((id: string) => {
    aircraftIdRef.current = id
    setAircraftIdState(id)
    persist(waypointsRef.current, legOverridesRef.current, id)
  }, [persist])

  /** Link (or unlink, with '') the working route to a saved routes-collection row. */
  const setActiveRouteId = useCallback((id: string) => {
    activeRouteIdRef.current = id
    setActiveRouteIdState(id)
    persist(waypointsRef.current, legOverridesRef.current, aircraftIdRef.current, id)
  }, [persist])

  const setEditSessionArmed = useCallback((armed: boolean) => { sessionArmedRef.current = armed }, [])
  const applyEditSession = useCallback(() => {
    sessionRef.current = null
    setEditSessionActive(false)
  }, [])
  const cancelEditSession = useCallback(() => {
    const s = sessionRef.current
    if (!s) return
    sessionRef.current = null
    setEditSessionActive(false)
    historyRef.current = s.history
    applySnapshot(s.snap)
  }, [applySnapshot])

  return [
    waypoints, setWaypoints, legOverrides, setLegOverrides, loadRoute,
    aircraftId, setAircraftId, activeRouteId, setActiveRouteId,
    {
      undo, redo,
      canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0,
      editSessionActive, setEditSessionArmed, applyEditSession, cancelEditSession,
    },
  ] as const
}

// ---------------------------------------------------------------------------
// Route Library hook — manages all named (non-current) saved routes.
// ---------------------------------------------------------------------------

export interface RouteLibraryHook {
  routes:      RouteDocType[]
  /**
   * Saves the given route data. If `routeId` is passed, updates that exact
   * row (the "Save" path — used when the working route is linked to an
   * existing saved route). If omitted, falls back to matching by exact
   * `name` against an existing row (overwrite-if-name-matches, otherwise
   * insert new) — the "Save As" path for an untitled/new route. Returns the
   * id of the row that was written, so the caller can link to it.
   */
  saveRoute:   (name: string, waypoints: RouteWaypoint[], legOverrides: LegOverride[], aircraftId?: string, routeId?: string) => Promise<string>
  loadRoute:   (id: string) => Promise<{ waypoints: RouteWaypoint[]; legOverrides: LegOverride[]; aircraftId: string } | null>
  deleteRoute: (id: string) => Promise<void>
  renameRoute: (id: string, name: string) => Promise<void>
}

export function useRouteLibrary(): RouteLibraryHook {
  const [routes, setRoutes] = useState<RouteDocType[]>([])

  useEffect(() => {
    let unsub: (() => void) | null = null
    getDb().then(db => {
      const subscription = db.routes.find({
        selector: { id: { $ne: ROUTE_ID } },
      }).$.subscribe(docs => {
        const sorted = [...docs].sort((a, b) => b.updatedAt - a.updatedAt)
        setRoutes(sorted.map(d => d.toJSON() as RouteDocType))
      })
      unsub = () => subscription.unsubscribe()
    }).catch(console.error)
    return () => unsub?.()
  }, [])

  const saveRoute = useCallback(async (
    name: string,
    waypoints: RouteWaypoint[],
    legOverrides: LegOverride[],
    aircraftId?: string,
    routeId?: string,
  ): Promise<string> => {
    const db = await getDb()
    // Id-resolution decision extracted into a pure, unit-tested helper (see
    // resolveSaveRouteId.test.ts) — `routeId` given → "Save" path, updates
    // that exact row. Not given → "Save As"/untitled path, reuses an
    // existing row's id only on an exact `name` match (excluding the live
    // 'current' working-route row), otherwise a fresh uuid is generated.
    // Must be a real UUID for new rows — user_routes.id is a Postgres UUID
    // column; any other string format 400s on every cloud push, silently
    // keeping the route local-only. Without the name-match reuse, every Save
    // with an unchanged name inserted a brand new row instead of updating
    // the one the user is looking at — confirmed live 2026-09-13: 3 clicks
    // of Save on "AGENT-SYNC-TEST" created 3 separate synced rows on both
    // web and native.
    const id = resolveSaveRouteId(routeId, name, routes, ROUTE_ID) ?? crypto.randomUUID()
    await db.routes.upsert({ id, name, waypoints, legOverrides, aircraftId: aircraftId ?? '', updatedAt: Date.now() })
    return id
  }, [routes])

  const loadRoute = useCallback(async (
    id: string,
  ): Promise<{ waypoints: RouteWaypoint[]; legOverrides: LegOverride[]; aircraftId: string } | null> => {
    const db = await getDb()
    const doc = await db.routes.findOne(id).exec()
    if (!doc) return null
    return { waypoints: doc.waypoints, legOverrides: doc.legOverrides ?? [], aircraftId: doc.aircraftId ?? '' }
  }, [])

  const deleteRoute = useCallback(async (id: string): Promise<void> => {
    const db = await getDb()
    const doc = await db.routes.findOne(id).exec()
    await doc?.remove()
  }, [])

  const renameRoute = useCallback(async (id: string, name: string): Promise<void> => {
    const db = await getDb()
    const doc = await db.routes.findOne(id).exec()
    if (doc) await doc.patch({ name, updatedAt: Date.now() })
  }, [])

  return { routes, saveRoute, loadRoute, deleteRoute, renameRoute }
}
