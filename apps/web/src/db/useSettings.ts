import { useState, useEffect, useCallback, useRef } from 'react'
import { getDb } from './index'
import { type Units, DEFAULT_UNITS } from '../utils/units'

const HOME_KEY  = 'home_airfield'
const UNITS_KEY = 'units'

export type HomeAirfield = {
  icao: string
  name: string
  lng: number
  lat: number
}

/**
 * Persists the home airfield to RxDB settings collection.
 * Returns [homeAirfield, setHomeAirfield].
 */
export function useHomeAirfield(): [HomeAirfield | null, (h: HomeAirfield | null) => void] {
  const [home, setHomeState] = useState<HomeAirfield | null>(null)

  useEffect(() => {
    getDb().then(async (db) => {
      const doc = await db.settings.findOne(HOME_KEY).exec()
      if (doc) {
        try {
          setHomeState(JSON.parse(doc.value) as HomeAirfield)
        } catch { /* ignore malformed */ }
      }
    }).catch(console.error)
  }, [])

  const setHome = useCallback((h: HomeAirfield | null) => {
    setHomeState(h)
    getDb().then(async (db) => {
      if (h === null) {
        const doc = await db.settings.findOne(HOME_KEY).exec()
        if (doc) await doc.remove()
      } else {
        await db.settings.upsert({ id: HOME_KEY, value: JSON.stringify(h) })
      }
    }).catch(console.error)
  }, [])

  return [home, setHome]
}

// ---------------------------------------------------------------------------
// useUnits — persists { distance: 'nm'|'km', speed: 'kts'|'kmh' } to settings
// ---------------------------------------------------------------------------
export function useUnits(): [Units, (u: Units) => void] {
  const [units, setUnitsState] = useState<Units>(DEFAULT_UNITS)

  useEffect(() => {
    getDb().then(async (db) => {
      const doc = await db.settings.findOne(UNITS_KEY).exec()
      if (doc) {
        try {
          setUnitsState({ ...DEFAULT_UNITS, ...(JSON.parse(doc.value) as Partial<Units>) })
        } catch { /* ignore */ }
      }
    }).catch(console.error)
  }, [])

  const setUnits = useCallback((u: Units) => {
    setUnitsState(u)
    getDb().then(async (db) => {
      await db.settings.upsert({ id: UNITS_KEY, value: JSON.stringify(u) })
    }).catch(console.error)
  }, [])

  return [units, setUnits]
}

// ---------------------------------------------------------------------------
// useTakeoffTime — persists planned departure as ISO string (or null)
// ---------------------------------------------------------------------------
const TAKEOFF_TIME_KEY = 'takeoff_time'

export function useTakeoffTime(): [Date | null, (d: Date | null) => void] {
  const [time, setTimeState] = useState<Date | null>(null)

  useEffect(() => {
    getDb().then(async (db) => {
      const doc = await db.settings.findOne(TAKEOFF_TIME_KEY).exec()
      if (doc) {
        const d = new Date(doc.value)
        if (!isNaN(d.getTime())) setTimeState(d)
      }
    }).catch(() => {})
  }, [])

  const setTime = useCallback((d: Date | null) => {
    setTimeState(d)
    getDb().then(async (db) => {
      if (d === null) {
        const doc = await db.settings.findOne(TAKEOFF_TIME_KEY).exec()
        if (doc) await doc.remove()
      } else {
        await db.settings.upsert({ id: TAKEOFF_TIME_KEY, value: d.toISOString() })
      }
    }).catch(() => {})
  }, [])

  return [time, setTime]
}

// ---------------------------------------------------------------------------
// useAlternate — persists alternate destination aerodrome
// ---------------------------------------------------------------------------
const ALTERNATE_KEY = 'alternate'

export type AlternateAirfield = { icao: string; name: string; lng: number; lat: number }

export function useAlternate(): [AlternateAirfield | null, (a: AlternateAirfield | null) => void] {
  const [alt, setAltState] = useState<AlternateAirfield | null>(null)

  useEffect(() => {
    getDb().then(async (db) => {
      const doc = await db.settings.findOne(ALTERNATE_KEY).exec()
      if (doc) {
        try { setAltState(JSON.parse(doc.value) as AlternateAirfield) } catch { /* ignore */ }
      }
    }).catch(() => {})
  }, [])

  const setAlt = useCallback((a: AlternateAirfield | null) => {
    setAltState(a)
    getDb().then(async (db) => {
      if (a === null) {
        const doc = await db.settings.findOne(ALTERNATE_KEY).exec()
        if (doc) await doc.remove()
      } else {
        await db.settings.upsert({ id: ALTERNATE_KEY, value: JSON.stringify(a) })
      }
    }).catch(() => {})
  }, [])

  return [alt, setAlt]
}

// ---------------------------------------------------------------------------
// useTheme — persists 'dark' | 'light' | 'high-contrast' and applies
//            data-theme attribute to :root so CSS tokens switch automatically
// ---------------------------------------------------------------------------
export type Theme = 'dark' | 'light' | 'high-contrast'
const THEME_KEY = 'theme'

function applyTheme(t: Theme) {
  if (t === 'dark') {
    delete document.documentElement.dataset.theme
  } else {
    document.documentElement.dataset.theme = t
  }
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>('dark')

  useEffect(() => {
    getDb().then(async (db) => {
      const doc = await db.settings.findOne(THEME_KEY).exec()
      if (doc) {
        const t = doc.value as Theme
        setThemeState(t)
        applyTheme(t)
      }
    }).catch(console.error)
  }, [])

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t)
    applyTheme(t)
    getDb().then(async (db) => {
      await db.settings.upsert({ id: THEME_KEY, value: t })
    }).catch(console.error)
  }, [])

  return [theme, setTheme]
}

// ---------------------------------------------------------------------------
// useGlobalWind — wind (WD °T, WS kts) applied to all planning legs unless a
// per-leg override is present. Persisted to RxDB.
// ---------------------------------------------------------------------------
export interface GlobalWind {
  dirDeg:   number   // FROM direction, degrees true
  speedKts: number
}

const GLOBAL_WIND_KEY = 'global_wind'

export function useGlobalWind(): [GlobalWind | null, (w: GlobalWind | null) => void] {
  const [wind, setWindState] = useState<GlobalWind | null>(null)

  useEffect(() => {
    getDb().then(async (db) => {
      const doc = await db.settings.findOne(GLOBAL_WIND_KEY).exec()
      if (doc) {
        try { setWindState(JSON.parse(doc.value) as GlobalWind) } catch { /* ignore */ }
      }
    }).catch(() => {})
  }, [])

  const setWind = useCallback((w: GlobalWind | null) => {
    setWindState(w)
    getDb().then(async (db) => {
      if (w === null) {
        const doc = await db.settings.findOne(GLOBAL_WIND_KEY).exec()
        if (doc) await doc.remove()
      } else {
        await db.settings.upsert({ id: GLOBAL_WIND_KEY, value: JSON.stringify(w) })
      }
    }).catch(() => {})
  }, [])

  return [wind, setWind]
}

// ---------------------------------------------------------------------------
// useAutoZoom — whether auto-zoom fires on takeoff/cruise transitions.
// Persisted to RxDB; defaults true.
// ---------------------------------------------------------------------------
const AUTO_ZOOM_KEY = 'auto_zoom'

export function useAutoZoom(): [boolean, (v: boolean) => void] {
  const [autoZoom, setAutoZoomState] = useState<boolean>(true)

  useEffect(() => {
    getDb().then(async (db) => {
      const doc = await db.settings.findOne(AUTO_ZOOM_KEY).exec()
      if (doc) setAutoZoomState(doc.value === 'true')
    }).catch(() => {})
  }, [])

  const setAutoZoom = useCallback((v: boolean) => {
    setAutoZoomState(v)
    getDb().then(async (db) => {
      await db.settings.upsert({ id: AUTO_ZOOM_KEY, value: String(v) })
    }).catch(() => {})
  }, [])

  return [autoZoom, setAutoZoom]
}

// ---------------------------------------------------------------------------
// useTrajectoryMode — 'time' (minutes ahead) or 'dist' (NM ahead).
// Persisted to RxDB; defaults 'time'.
// ---------------------------------------------------------------------------
export type TrajectoryMode = 'time' | 'dist'
const TRAJECTORY_MODE_KEY = 'trajectory_mode'

export function useTrajectoryMode(): [TrajectoryMode, (v: TrajectoryMode) => void] {
  const [mode, setModeState] = useState<TrajectoryMode>('time')

  useEffect(() => {
    getDb().then(async (db) => {
      const doc = await db.settings.findOne(TRAJECTORY_MODE_KEY).exec()
      if (doc) setModeState(doc.value === 'dist' ? 'dist' : 'time')
    }).catch(() => {})
  }, [])

  const setMode = useCallback((v: TrajectoryMode) => {
    setModeState(v)
    getDb().then(async (db) => {
      await db.settings.upsert({ id: TRAJECTORY_MODE_KEY, value: v })
    }).catch(() => {})
  }, [])

  return [mode, setMode]
}

// ---------------------------------------------------------------------------
// useAirspaceWarnLookahead — how many minutes ahead to warn about airspace
// penetration. Persisted to RxDB; default 5 minutes.
// Valid values: 2 | 5 | 10 | 15
// ---------------------------------------------------------------------------
export type AirspaceWarnLookahead = 2 | 5 | 10 | 15
export const AIRSPACE_WARN_LOOKAHEAD_OPTIONS: AirspaceWarnLookahead[] = [2, 5, 10, 15]
const AIRSPACE_WARN_LOOKAHEAD_KEY = 'airspace_warn_lookahead'

export function useAirspaceWarnLookahead(): [AirspaceWarnLookahead, (v: AirspaceWarnLookahead) => void] {
  const [val, setValState] = useState<AirspaceWarnLookahead>(5)

  useEffect(() => {
    getDb().then(async (db) => {
      const doc = await db.settings.findOne(AIRSPACE_WARN_LOOKAHEAD_KEY).exec()
      if (doc) {
        const raw = parseInt(doc.value, 10)
        if (([2, 5, 10, 15] as AirspaceWarnLookahead[]).includes(raw as AirspaceWarnLookahead)) {
          setValState(raw as AirspaceWarnLookahead)
        }
      }
    }).catch(() => {})
  }, [])

  const setVal = useCallback((v: AirspaceWarnLookahead) => {
    setValState(v)
    getDb().then(async (db) => {
      await db.settings.upsert({ id: AIRSPACE_WARN_LOOKAHEAD_KEY, value: String(v) })
    }).catch(() => {})
  }, [])

  return [val, setVal]
}

// ---------------------------------------------------------------------------
// useAirspaceWarnVerticalFt — static vertical buffer (ft) around an airspace
// floor/ceiling that triggers a closure warning regardless of climb/descent
// rate. 0 = off (rate-based projection only). Persisted to RxDB; default 500.
// ---------------------------------------------------------------------------
export const AIRSPACE_WARN_VERTICAL_OPTIONS = [0, 100, 200, 300, 500, 750, 1000, 1500]
const AIRSPACE_WARN_VERTICAL_KEY = 'airspace_warn_vertical_ft'

export function useAirspaceWarnVerticalFt(): [number, (v: number) => void] {
  const [val, setValState] = useState<number>(500)

  useEffect(() => {
    getDb().then(async (db) => {
      const doc = await db.settings.findOne(AIRSPACE_WARN_VERTICAL_KEY).exec()
      if (doc) {
        const raw = parseInt(doc.value, 10)
        if (AIRSPACE_WARN_VERTICAL_OPTIONS.includes(raw)) setValState(raw)
      }
    }).catch(() => {})
  }, [])

  const setVal = useCallback((v: number) => {
    setValState(v)
    getDb().then(async (db) => {
      await db.settings.upsert({ id: AIRSPACE_WARN_VERTICAL_KEY, value: String(v) })
    }).catch(() => {})
  }, [])

  return [val, setVal]
}

// ── Terrain colour-relief ─────────────────────────────────────────────────────
// Overlay colour bands on the map based on a reference altitude.
// Colour bands (all relative to refAltFt):
//   Red    → < 500 ft below ref (within 500 ft)
//   Orange → < 1,000 ft below ref
//   Yellow → < 1,500 ft below ref
//   Green  → > 1,500 ft below ref (safe)

const TERRAIN_COLOR_KEY = 'ovfr:terrainColor'

export interface TerrainColoringSettings {
  enabled:  boolean
  refAltFt: number  // reference altitude in feet MSL (default 2000)
}

const TERRAIN_COLOR_DEFAULT: TerrainColoringSettings = { enabled: false, refAltFt: 2000 }

export function useTerrainColoring(): [TerrainColoringSettings, (v: TerrainColoringSettings) => void] {
  const [val, setValState] = useState<TerrainColoringSettings>(TERRAIN_COLOR_DEFAULT)

  useEffect(() => {
    getDb().then(async (db) => {
      const doc = await db.settings.findOne(TERRAIN_COLOR_KEY).exec()
      if (doc) {
        try {
          const parsed = JSON.parse(doc.value) as Partial<TerrainColoringSettings>
          setValState({
            enabled:  Boolean(parsed.enabled),
            refAltFt: typeof parsed.refAltFt === 'number' && parsed.refAltFt > 0 ? Math.round(parsed.refAltFt) : 2000,
          })
        } catch { /* ignore */ }
      }
    }).catch(() => {})
  }, [])

  const setVal = useCallback((v: TerrainColoringSettings) => {
    setValState(v)
    getDb().then(async (db) => {
      await db.settings.upsert({ id: TERRAIN_COLOR_KEY, value: JSON.stringify(v) })
    }).catch(() => {})
  }, [])

  return [val, setVal]
}

// ---------------------------------------------------------------------------
// useTrafficVertFilter — hide traffic targets more than N feet above/below
// current ownship altitude. Default 5000 ft. 0 = off (show all).
// Persisted to RxDB.
// ---------------------------------------------------------------------------
export const TRAFFIC_VERT_FILTER_OPTIONS = [1000, 2000, 3000, 5000, 10000, 0] as const
export type TrafficVertFilter = (typeof TRAFFIC_VERT_FILTER_OPTIONS)[number]
const TRAFFIC_VERT_FILTER_KEY = 'ovfr:trafficVertFilter'

export function useTrafficVertFilter(): [TrafficVertFilter, (v: TrafficVertFilter) => void] {
  const [val, setValState] = useState<TrafficVertFilter>(5000)

  useEffect(() => {
    getDb().then(async (db) => {
      const doc = await db.settings.findOne(TRAFFIC_VERT_FILTER_KEY).exec()
      if (doc) {
        const raw = parseInt(doc.value, 10)
        if ((TRAFFIC_VERT_FILTER_OPTIONS as readonly number[]).includes(raw)) {
          setValState(raw as TrafficVertFilter)
        }
      }
    }).catch(() => {})
  }, [])

  const setVal = useCallback((v: TrafficVertFilter) => {
    setValState(v)
    getDb().then(async (db) => {
      await db.settings.upsert({ id: TRAFFIC_VERT_FILTER_KEY, value: String(v) })
    }).catch(() => {})
  }, [])

  return [val, setVal]
}

// ---------------------------------------------------------------------------
// useLayerVisibility — which map layer groups are toggled on/off.
// Persisted to RxDB; initialises from LAYER_GROUPS defaultOn values.
// ---------------------------------------------------------------------------
import { LAYER_GROUPS } from '../styles/map-style'

const LAYER_VISIBILITY_KEY = 'ovfr:layerVisibility'

function defaultLayerVisibility(): Record<string, boolean> {
  return Object.fromEntries(LAYER_GROUPS.map((g) => [g.id, g.defaultOn]))
}

export function useLayerVisibility(): [Record<string, boolean>, (groupId: string, on: boolean) => void] {
  const [visibility, setVisibilityState] = useState<Record<string, boolean>>(defaultLayerVisibility)

  // Guards a real race: this hook's initial load is an async RxDB round trip
  // (getDb().then(...).then(doc => ...)). If the user toggles a layer via
  // setVisibility() BEFORE that initial load resolves, the load's callback
  // would otherwise fire afterward and silently overwrite the just-clicked
  // state with the stale pre-click value read from disk -- the toggle UI
  // label stays showing the new (correct) value (same shared state, but a
  // LATER render already reverted it before the user could see it flip back)
  // while the actual MapLibre layer visibility never gets (re)applied,
  // because the visibility-sync effect in MapView.tsx re-runs off the
  // reverted value. Confirmed via a live repro: `hillshade`'s MapLibre layer
  // stuck at layout visibility 'none' after clicking the toggle to ON,
  // traced to exactly this sequence (apply() logged on=true, then on=false
  // moments later with no further user action). Once the user has made any
  // edit, the initial DB load is no longer authoritative for this session --
  // skip applying it entirely rather than trying to merge (edge case is rare
  // enough that losing an as-yet-unloaded OTHER toggle's stored value in
  // that narrow window is an acceptable, much smaller regression than
  // reliably breaking every toggle clicked quickly after page load).
  const hasUserEditedRef = useRef(false)

  useEffect(() => {
    getDb().then(async (db) => {
      const doc = await db.settings.findOne(LAYER_VISIBILITY_KEY).exec()
      if (hasUserEditedRef.current) return // user already toggled before this resolved -- don't clobber
      if (doc) {
        try {
          const stored = JSON.parse(doc.value) as Record<string, boolean>
          // 'classC' was one toggle for CTR + TMA; it is now two. Carry the old
          // choice over so nobody's layers change on upgrade.
          if ('classC' in stored) {
            stored.classCtr ??= stored.classC
            stored.classCtma ??= stored.classC
            delete stored.classC
          }
          setVisibilityState({ ...defaultLayerVisibility(), ...stored })
        } catch { /* ignore */ }
      }
    }).catch(() => {})
  }, [])

  const setVisibility = useCallback((groupId: string, on: boolean) => {
    hasUserEditedRef.current = true
    setVisibilityState((prev) => {
      const next = { ...prev, [groupId]: on }
      getDb().then(async (db) => {
        await db.settings.upsert({ id: LAYER_VISIBILITY_KEY, value: JSON.stringify(next) })
      }).catch(() => {})
      return next
    })
  }, [])

  return [visibility, setVisibility]
}

// ---------------------------------------------------------------------------
// useAirspaceCeiling — altitude ceiling filter for airspace layers (feet).
// Persisted to RxDB; defaults to DEFAULT_CEILING_FT from map-style.
// ---------------------------------------------------------------------------
import { DEFAULT_CEILING_FT } from '../styles/map-style'

const AIRSPACE_CEILING_KEY = 'ovfr:airspaceCeiling'

export function useAirspaceCeiling(): [number, (ft: number) => void] {
  const [ceiling, setCeilingState] = useState<number>(DEFAULT_CEILING_FT)

  useEffect(() => {
    getDb().then(async (db) => {
      const doc = await db.settings.findOne(AIRSPACE_CEILING_KEY).exec()
      if (doc) {
        const raw = parseInt(doc.value, 10)
        if (isFinite(raw) && raw > 0) setCeilingState(raw)
      }
    }).catch(() => {})
  }, [])

  const setCeiling = useCallback((ft: number) => {
    setCeilingState(ft)
    getDb().then(async (db) => {
      await db.settings.upsert({ id: AIRSPACE_CEILING_KEY, value: String(ft) })
    }).catch(() => {})
  }, [])

  return [ceiling, setCeiling]
}

// ---------------------------------------------------------------------------
// useParkTimeout — seconds to wait after landing before closing the flight log.
// 0 = split every touch-and-go into a separate log (legacy behaviour).
// Persisted to RxDB; default 300 s (5 min).
// ---------------------------------------------------------------------------
export const PARK_TIMEOUT_OPTIONS = [0, 60, 120, 300, 600] as const
export type ParkTimeoutOption = typeof PARK_TIMEOUT_OPTIONS[number]
const PARK_TIMEOUT_KEY = 'ovfr:parkTimeout'
const PARK_TIMEOUT_DEFAULT: ParkTimeoutOption = 300

export function useParkTimeout(): [ParkTimeoutOption, (v: ParkTimeoutOption) => void] {
  const [val, setValState] = useState<ParkTimeoutOption>(PARK_TIMEOUT_DEFAULT)

  useEffect(() => {
    getDb().then(async (db) => {
      const doc = await db.settings.findOne(PARK_TIMEOUT_KEY).exec()
      if (doc) {
        const raw = parseInt(doc.value, 10)
        if ((PARK_TIMEOUT_OPTIONS as readonly number[]).includes(raw)) {
          setValState(raw as ParkTimeoutOption)
        }
      }
    }).catch(() => {})
  }, [])

  const setVal = useCallback((v: ParkTimeoutOption) => {
    setValState(v)
    getDb().then(async (db) => {
      await db.settings.upsert({ id: PARK_TIMEOUT_KEY, value: String(v) })
    }).catch(() => {})
  }, [])

  return [val, setVal]
}

// ---------------------------------------------------------------------------
// useSelectedAircraftId — ID of the active aircraft profile.
// Persisted to RxDB; null = no aircraft selected.
// ---------------------------------------------------------------------------
const SELECTED_AIRCRAFT_KEY = 'ovfr:selectedAircraft'

export function useSelectedAircraftId(): [string | null, (id: string | null) => void] {
  const [id, setIdState] = useState<string | null>(null)

  useEffect(() => {
    getDb().then(async (db) => {
      const doc = await db.settings.findOne(SELECTED_AIRCRAFT_KEY).exec()
      if (doc) setIdState(doc.value || null)
    }).catch(() => {})
  }, [])

  const setId = useCallback((v: string | null) => {
    setIdState(v)
    getDb().then(async (db) => {
      if (v === null) {
        const doc = await db.settings.findOne(SELECTED_AIRCRAFT_KEY).exec()
        if (doc) await doc.remove()
      } else {
        await db.settings.upsert({ id: SELECTED_AIRCRAFT_KEY, value: v })
      }
    }).catch(() => {})
  }, [])

  return [id, setId]
}
