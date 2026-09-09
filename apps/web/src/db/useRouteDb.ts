import { useState, useEffect, useCallback, useRef } from 'react'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { LegOverride, RouteDocType } from './index'
import { getDb } from './index'

const ROUTE_ID = 'current'
const LS_KEY   = 'openvfr.route'

type WaypointSetter = (updater: RouteWaypoint[] | ((prev: RouteWaypoint[]) => RouteWaypoint[])) => void
type OverrideSetter = (updater: LegOverride[]  | ((prev: LegOverride[])  => LegOverride[]))  => void

/**
 * Persistent route hook backed by RxDB/IndexedDB.
 * Returns [waypoints, setWaypoints, legOverrides, setLegOverrides].
 * Drops in as a replacement for useState; migrates from localStorage on first use.
 */
export function usePersistedRoute(): [RouteWaypoint[], WaypointSetter, LegOverride[], OverrideSetter, (wps: RouteWaypoint[], ovr: LegOverride[], aircraftId?: string) => void, string, (id: string) => void] {
  const [waypoints, setWaypointsState]       = useState<RouteWaypoint[]>([])
  const [legOverrides, setLegOverridesState] = useState<LegOverride[]>([])
  const [aircraftId, setAircraftIdState]     = useState<string>('')

  // Refs always mirror the latest state so persist callbacks never close over stale values.
  const waypointsRef    = useRef<RouteWaypoint[]>([])
  const legOverridesRef = useRef<LegOverride[]>([])
  const aircraftIdRef   = useRef<string>('')
  waypointsRef.current    = waypoints
  legOverridesRef.current = legOverrides
  aircraftIdRef.current   = aircraftId

  // Load once on mount; migrate from localStorage if RxDB has no saved route yet.
  useEffect(() => {
    getDb().then(async (db) => {
      const doc = await db.routes.findOne(ROUTE_ID).exec()
      if (doc) {
        setWaypointsState([...doc.waypoints] as RouteWaypoint[])
        setLegOverridesState([...(doc.legOverrides ?? [])] as LegOverride[])
        setAircraftIdState(doc.aircraftId ?? '')
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

  const persist = useCallback((wps: RouteWaypoint[], ovr: LegOverride[], acId?: string) => {
    getDb().then((db) =>
      db.routes.upsert({
        id: ROUTE_ID, name: 'Current Route', waypoints: wps, legOverrides: ovr,
        aircraftId: acId ?? aircraftIdRef.current, updatedAt: Date.now(),
      })
    ).catch(console.error)
  }, [])

  const setWaypoints = useCallback<WaypointSetter>((updater) => {
    setWaypointsState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      // Trim overrides to at most (next.length - 1) entries when waypoints shrink.
      const trimmed = legOverridesRef.current.slice(0, Math.max(0, next.length - 1))
      // Update refs synchronously so a setLegOverrides call in the same event
      // handler (e.g. delete-waypoint handlers that call both setters back to
      // back) doesn't persist() with a stale pre-update value — refs otherwise
      // only update on next render, causing the later persist() to overwrite
      // IndexedDB with the old array.
      waypointsRef.current    = next
      legOverridesRef.current = trimmed
      setLegOverridesState(trimmed)
      persist(next, trimmed)
      return next
    })
  }, [persist])

  const setLegOverrides = useCallback<OverrideSetter>((updater) => {
    setLegOverridesState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      legOverridesRef.current = next
      persist(waypointsRef.current, next)
      return next
    })
  }, [persist])

  /** Atomically replace both waypoints and leg overrides (used by Route Library load). */
  const loadRoute = useCallback((wps: RouteWaypoint[], ovr: LegOverride[], acId?: string) => {
    const safeOvr = ovr.slice(0, Math.max(0, wps.length - 1))
    const nextAcId = acId ?? ''
    waypointsRef.current    = wps
    legOverridesRef.current = safeOvr
    aircraftIdRef.current   = nextAcId
    setWaypointsState(wps)
    setLegOverridesState(safeOvr)
    setAircraftIdState(nextAcId)
    persist(wps, safeOvr, nextAcId)
  }, [persist])

  /** Set the aircraft profile associated with the current working route. */
  const setAircraftId = useCallback((id: string) => {
    aircraftIdRef.current = id
    setAircraftIdState(id)
    persist(waypointsRef.current, legOverridesRef.current, id)
  }, [persist])

  return [waypoints, setWaypoints, legOverrides, setLegOverrides, loadRoute, aircraftId, setAircraftId] as const
}

// ---------------------------------------------------------------------------
// Route Library hook — manages all named (non-current) saved routes.
// ---------------------------------------------------------------------------

export interface RouteLibraryHook {
  routes:      RouteDocType[]
  saveRoute:   (name: string, waypoints: RouteWaypoint[], legOverrides: LegOverride[], aircraftId?: string) => Promise<void>
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
  ): Promise<void> => {
    const db = await getDb()
    // Must be a real UUID — user_routes.id is a Postgres UUID column; any other
    // string format 400s on every cloud push, silently keeping the route local-only.
    const id = crypto.randomUUID()
    await db.routes.upsert({ id, name, waypoints, legOverrides, aircraftId: aircraftId ?? '', updatedAt: Date.now() })
  }, [])

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
