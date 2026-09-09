/**
 * useSettings — reads/writes app settings via AsyncStorage (same key/value
 * structure as the web project's RxDB settings collection).
 */

import { useEffect, useState, useCallback } from 'react'
import { settings as db } from '../db'
import type { Units } from '../utils/units'
import { DEFAULT_UNITS } from '../utils/units'

export type AppSettings = {
  units:        Units
  homeAirfield: string
  selectedAircraftId: string
  airspaceCeilingFt: number
  autoZoom:     boolean
  trajectoryNm: number
  /** Horizontal lookahead in minutes for airspace penetration warnings */
  airspaceWarnLookaheadMin: number
  /** Vertical buffer in feet — warn when within this distance of a floor/ceiling */
  airspaceWarnVerticalFt: number
  /** Trajectory mode: project N minutes ahead (time) or fixed NM (nm) */
  trajectoryMode: 'time' | 'nm'
  /** GaugesBar T.ALT field: show Height AGL instead of AMSL (tap to toggle) */
  showAltitudeAgl: boolean
  /** GaugesBar P.ALT gauge: show current QNH (hPa) instead of the FL/altitude value (tap to toggle) */
  showQnhOnPaltGauge: boolean
  /** GaugesBar clock gauge: show local device time instead of UTC/Zulu (tap to toggle) */
  showLocalTime: boolean
  /** QNH in hPa. Manual value used when qnhAuto is false, or as the fallback
   *  display value when qnhAuto is true but no nearby METAR is available yet. */
  qnhHpa: number
  /** true = follow nearest-METAR QNH automatically (default); false = use qnhHpa as a fixed manual value. */
  qnhAuto: boolean
  /** Explicit pilot opt-in for using the phone's internal barometric sensor
   *  (tier 1 altitude source) — default OFF, gated behind a safety warning
   *  in Settings (see native/docs/ble-vario-plan.md §5.1). Phone barometers
   *  measure pocket/cabin pressure, not true static pressure, and can be
   *  meaningfully inaccurate depending on how the device is carried. */
  useInternalBarometer: boolean
  /** Last-connected BlueFly Vario BLE device ID, empty = none/manual reconnect. */
  varioAutoConnectId: string
}

const DEFAULTS: AppSettings = {
  units:               DEFAULT_UNITS,
  homeAirfield:        '',
  selectedAircraftId:  '',
  airspaceCeilingFt:   9_500,
  autoZoom:            true,
  trajectoryNm:        5,
  airspaceWarnLookaheadMin: 5,
  airspaceWarnVerticalFt:   500,
  trajectoryMode:           'time',
  showAltitudeAgl:          false,
  showQnhOnPaltGauge:       false,
  showLocalTime:            false,
  qnhHpa:                   1013.25,
  qnhAuto:                  true,
  useInternalBarometer:     false,
  varioAutoConnectId:       '',
}

export function useSettings() {
  const [settings, setSettingsState] = useState<AppSettings>(DEFAULTS)
  const [loaded, setLoaded]          = useState(false)

  // Load on mount
  useEffect(() => {
    db.get<AppSettings>('app_settings').then((stored) => {
      if (stored) setSettingsState({ ...DEFAULTS, ...stored })
      setLoaded(true)
    })
  }, [])

  const update = useCallback(async (patch: Partial<AppSettings>) => {
    const next = { ...settings, ...patch }
    setSettingsState(next)
    await db.set('app_settings', next)
  }, [settings])

  return { settings, update, loaded }
}
