/**
 * usePlanningSettings — persisted route-planning globals shared with the web
 * project's `src/db/useSettings.ts` (same key names: 'takeoff_time',
 * 'alternate', 'global_wind') so the values round-trip once cloud sync for
 * these settings ships. Stored via the generic `settings` key/value table
 * (native/src/db/index.ts), same AsyncStorage-backed store used for
 * `app_settings`.
 */

import { useEffect, useState, useCallback } from 'react'
import { settings as db } from '../db'

// ---------------------------------------------------------------------------
// useTakeoffTime — planned departure, persisted as ISO string (or null)
// ---------------------------------------------------------------------------
const TAKEOFF_TIME_KEY = 'takeoff_time'

export function useTakeoffTime(): [Date | null, (d: Date | null) => void] {
  const [time, setTimeState] = useState<Date | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    db.get<string>(TAKEOFF_TIME_KEY).then((iso) => {
      if (iso) {
        const d = new Date(iso)
        if (!isNaN(d.getTime())) setTimeState(d)
      }
      setLoaded(true)
    })
  }, [])

  const setTime = useCallback((d: Date | null) => {
    setTimeState(d)
    if (d) db.set(TAKEOFF_TIME_KEY, d.toISOString())
    else db.remove(TAKEOFF_TIME_KEY)
  }, [])

  return loaded ? [time, setTime] : [null, setTime]
}

// ---------------------------------------------------------------------------
// useAlternate — alternate destination aerodrome
// ---------------------------------------------------------------------------
export type AlternateAirfield = { icao: string; name: string; lng: number; lat: number }
const ALTERNATE_KEY = 'alternate'

export function useAlternate(): [AlternateAirfield | null, (a: AlternateAirfield | null) => void] {
  const [alt, setAltState] = useState<AlternateAirfield | null>(null)

  useEffect(() => {
    db.get<AlternateAirfield>(ALTERNATE_KEY).then((v) => { if (v) setAltState(v) })
  }, [])

  const setAlt = useCallback((a: AlternateAirfield | null) => {
    setAltState(a)
    if (a) db.set(ALTERNATE_KEY, a)
    else db.remove(ALTERNATE_KEY)
  }, [])

  return [alt, setAlt]
}

// ---------------------------------------------------------------------------
// useGlobalWind — wind applied to all planning legs unless leg-overridden
// ---------------------------------------------------------------------------
export interface GlobalWind {
  dirDeg:   number
  speedKts: number
}
const GLOBAL_WIND_KEY = 'global_wind'

export function useGlobalWind(): [GlobalWind | null, (w: GlobalWind | null) => void] {
  const [wind, setWindState] = useState<GlobalWind | null>(null)

  useEffect(() => {
    db.get<GlobalWind>(GLOBAL_WIND_KEY).then((v) => { if (v) setWindState(v) })
  }, [])

  const setWind = useCallback((w: GlobalWind | null) => {
    setWindState(w)
    if (w) db.set(GLOBAL_WIND_KEY, w)
    else db.remove(GLOBAL_WIND_KEY)
  }, [])

  return [wind, setWind]
}
