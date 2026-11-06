/**
 * usePreflightCheck (native) — the pre-flight warnings and prompts for the
 * planned route. Gathers the remaining inputs (airspace, aerodromes, regional
 * NOTAMs, the user's airspace levels) and hands them, with the terrain and
 * MSA that useLegMsa already computed, to the shared pure functions, as the
 * web panel does (see apps/web/src/components/PreflightWarnings.tsx).
 *
 * Heavy work waits until the route has been still, and nothing re-runs while
 * the plan screen is not in front; the last result stays, so coming back to an
 * unchanged route is free.
 */
import { useEffect, useMemo, useState } from 'react'
import { useIsFocused } from '@react-navigation/native'
import { buildVirtualRadarProfile, applyTerrainToBands, type VirtualRadarProfile } from '@open-vfr/shared/virtualRadarCalc'
import { computeWarnings, type PreflightWarning } from '@open-vfr/shared/preflightWarnings'
import { computePrompts, type PreflightPrompt } from '@open-vfr/shared/preflightPrompts'
import { resolveMsaMargins } from '@open-vfr/shared/msaMargins'
import { resolveAirspaceLevels } from '@open-vfr/shared/airspaceAlertLevel'
import { notamRegionsFor } from '@open-vfr/shared/notamRegionScope'
import { isIfrOnly } from '@open-vfr/shared/notamRelevance'
import { onActiveCountriesChange } from '@open-vfr/shared/countryData'
import { getTileUrls } from '../config'
import { loadGeoJsonOnce } from '../utils/geoJsonCache'
import { useCountries } from './useCountries'
import { useRegionalNotams } from './useRegionalNotams'
import { useSettled, ROUTE_SETTLE_MS } from './useSettled'
import type { LegMsa } from './useLegMsa'
import { useSettingsContext } from '../context/SettingsContext'
import { useAuthContext } from '../context/AuthContext'
import type { RouteWaypoint, LegOverride, AircraftProfileDocType } from '../types/db'

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

export interface PreflightCheck {
  warnings: PreflightWarning[]
  prompts:  PreflightPrompt[]
  /** Terrain and the data files are still loading. */
  loading:  boolean
  /** The route the warnings were computed for (places in them are along this route). */
  waypoints: RouteWaypoint[]
}

export function usePreflightCheck(opts: {
  /** Terrain, MSA and the settled route, from useLegMsa. */
  msa: LegMsa
  legOverrides: LegOverride[]
  aircraft: AircraftProfileDocType | null
  aircraftId: string | null
  legWinds: ({ dirDeg: number; speedKts: number } | null)[]
  windsLoading: boolean
  enabled: boolean
}): PreflightCheck {
  const { msa, aircraft, aircraftId } = opts
  const focused = useIsFocused()
  const hold = !focused
  const waypoints = msa.waypoints
  const legOverrides = useSettled(opts.legOverrides, ROUTE_SETTLE_MS, hold)
  const legWinds = useSettled(opts.legWinds, ROUTE_SETTLE_MS, hold)
  const windsLoading = useSettled(opts.windsLoading, ROUTE_SETTLE_MS, hold)
  const { settings } = useSettingsContext()
  const { state: authState } = useAuthContext()
  const { selected: selectedCountries } = useCountries()
  const active = opts.enabled && waypoints.length >= 2
  const signedIn = authState.status === 'authenticated'

  const [countryTick, setCountryTick] = useState(0)
  useEffect(() => onActiveCountriesChange(() => setCountryTick((t) => t + 1)), [])

  // Data files. A file that fails to load is recorded, not treated as empty: the card says the check did not run.
  const [airspaceGeo, setAirspaceGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [aerodromeGeo, setAerodromeGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [airspaceFailed, setAirspaceFailed] = useState(false)
  const [aerodromesFailed, setAerodromesFailed] = useState(false)
  useEffect(() => {
    if (!active) return
    let alive = true
    const urls = getTileUrls()
    setAirspaceFailed(false); setAerodromesFailed(false)
    loadGeoJsonOnce(urls.airspace).then((d) => alive && setAirspaceGeo(d)).catch(() => { if (alive) { setAirspaceGeo(EMPTY_FC); setAirspaceFailed(true) } })
    loadGeoJsonOnce(urls.aerodromes).then((d) => alive && setAerodromeGeo(d)).catch(() => { if (alive) { setAerodromeGeo(null); setAerodromesFailed(true) } })
    return () => { alive = false }
  }, [active, countryTick])

  const margins = settings.msaMargins
  const airspaceLevels = useMemo(() => resolveAirspaceLevels(settings.alertAirspaceLevels), [settings.alertAirspaceLevels])

  // Airspace bands only: obstacles and MSA come from useLegMsa, so the obstacle scan is not repeated.
  const rawProfile = useMemo<VirtualRadarProfile | null>(() => {
    if (!active || !airspaceGeo) return null
    return buildVirtualRadarProfile(
      waypoints, legOverrides, airspaceGeo, EMPTY_FC, undefined, undefined, Infinity,
      aircraft?.cruiseAltFt || undefined,
    )
  }, [active, waypoints, legOverrides, airspaceGeo, aircraft?.cruiseAltFt])
  const profile = useMemo(
    () => rawProfile && { ...rawProfile, airspaceBands: applyTerrainToBands(rawProfile.airspaceBands, msa.terrain) },
    [rawProfile, msa.terrain],
  )

  // Regional NOTAMs for the countries the route touches (poller shared with the map).
  const notamRegions = useMemo(
    () => notamRegionsFor({ selected: selectedCountries, route: waypoints }),
    [selectedCountries, waypoints],
  )
  const regionalNotams = useRegionalNotams(active && signedIn, notamRegions)
  const vfrNotams = useMemo(() => regionalNotams.filter((n) => !isIfrOnly(n)), [regionalNotams])

  const warnings = useMemo<PreflightWarning[]>(() => {
    if (!profile || !msa.ready) return []
    const unavailable: NonNullable<Parameters<typeof computeWarnings>[9]>['unavailable'] = {}
    if (airspaceFailed) unavailable.airspace = 'failed'
    if (msa.obstaclesFailed) unavailable.obstacles = 'failed'
    if (aerodromesFailed) unavailable.aerodromes = 'failed'
    if (!signedIn) unavailable.notams = 'Sign in to check restricted areas created by NOTAM.'
    return computeWarnings(
      profile, msa.msaPts, aircraft ?? undefined, waypoints, legOverrides, aircraftId ?? undefined,
      msa.terrainFailed, legWinds, resolveMsaMargins(margins),
      { terrainPts: msa.terrain, airspaceLevels, aerodromes: aerodromeGeo, notams: vfrNotams, airspace: airspaceGeo, unavailable },
    )
  }, [profile, msa, aircraft, waypoints, legOverrides, aircraftId, legWinds, margins, airspaceLevels, aerodromeGeo, vfrNotams, airspaceGeo, airspaceFailed, aerodromesFailed, signedIn])

  const prompts = useMemo(
    () => computePrompts({ waypoints, legWinds, windsLoading }),
    [waypoints, legWinds, windsLoading],
  )

  return { warnings, prompts, loading: active && (!msa.ready || !profile), waypoints }
}
