/**
 * Pre-flight planning warnings panel.
 *
 * Renders the warnings from `computeWarnings` (shared with native).
 */

import { useMsaMargins, useAlertBanners } from '../db/useSettings'
import { resolveMsaMargins } from '@open-vfr/shared/msaMargins'
import { computeWarnings, type PreflightUnavailable, type PreflightWarning } from '@open-vfr/shared/preflightWarnings'
import { computePrompts } from '@open-vfr/shared/preflightPrompts'
import { ROUTE_SETTLE_MS } from '@open-vfr/shared/routeSettle'
import { notamRegionsFor } from '@open-vfr/shared/notamRegionScope'
import { isIfrOnly } from '@open-vfr/shared/notamRelevance'
import { useCountries } from '../hooks/useCountries'
import { useRegionalNotamsState } from '../hooks/useRegionalNotams'
import { obstacleTipsForMsa } from '@open-vfr/shared/obstacleHeights'
import { fetchTerrainProfileShared } from '@open-vfr/shared/terrainCache'
import { useMefGrids } from '../hooks/useMefGrids'
import { useState, useEffect, useMemo } from 'react'
import {
  buildVirtualRadarProfile,
  computeMsaProfile,
  terrainForMsa,
  applyTerrainToBands,
  terrainAt,
  coordinateAlongRouteNm,
  type VirtualRadarProfile,
  type MsaPoint,
  type TerrainPoint,
} from '@open-vfr/shared/virtualRadarCalc'
import { getRemoteDem } from '../utils/terrainDem'
import { API_BASE_URL } from '../utils/env'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { RouteWeatherStation } from '../hooks/useWeatherAlongRoute'
import type { ParsedWind } from '@open-vfr/shared/fetchWx'
import { metarSurfaceWind } from '@open-vfr/shared/crosswindCheck'
import { parseMetarTempC } from '@open-vfr/shared/runwayPerformance'
import type { LegOverride, AircraftProfileDocType } from '../db/index'
import css from './PreflightWarnings.module.css'
import { loadCountryGeojson, activeCountriesKey } from '@open-vfr/shared/countryData'
import { IconCheck } from '@tabler/icons-react'

// ---------------------------------------------------------------------------
// Data files: one load per file and country selection, shared by every mount.
// A file that fails to load is reported (the check that needs it did not run),
// not treated as empty, and is fetched again the next time the panel opens.
// ---------------------------------------------------------------------------

type GeoKind = 'airspace' | 'obstacles' | 'landmarks' | 'aerodromes'
const _geo: Partial<Record<GeoKind, { key: string; p: Promise<GeoJSON.FeatureCollection> }>> = {}
const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

function loadGeo(kind: GeoKind): Promise<GeoJSON.FeatureCollection> {
  const key = activeCountriesKey()   // a new country selection drops the cached data
  const cur = _geo[kind]
  if (cur && cur.key === key) return cur.p
  const p = loadCountryGeojson(kind)
  p.catch(() => { if (_geo[kind]?.p === p) delete _geo[kind] })
  _geo[kind] = { key, p }
  return p
}

function useGeo(kind: GeoKind): { fc: GeoJSON.FeatureCollection | null; failed: boolean } {
  const [state, setState] = useState<{ fc: GeoJSON.FeatureCollection | null; failed: boolean }>({ fc: null, failed: false })
  useEffect(() => {
    let alive = true
    loadGeo(kind)
      .then((fc) => { if (alive) setState({ fc, failed: false }) })
      .catch(() => { if (alive) setState({ fc: null, failed: true }) })
    return () => { alive = false }
  }, [kind])
  return state
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  waypoints:    RouteWaypoint[]
  legOverrides: LegOverride[]
  aircraft?:    AircraftProfileDocType
  /** aircraft_profile id stored on the current route, if any — used only to
   *  detect the orphaned-reference case (id set, but `aircraft` undefined). */
  aircraftId?:  string
  /** Effective wind per leg (override > global > forecast), for the fuel check. */
  legWinds?:    ({ dirDeg: number; speedKts: number } | null)[]
  /** Wind forecast still loading: the missing-wind prompt waits. */
  windsLoading?: boolean
  /** Signed in: the NOTAM check needs the account (the endpoint answers 401 otherwise). */
  signedIn?:    boolean
  /** Applies a warning's one-tap fix (raise a leg to its MSA). */
  onSetLegOverride?: (idx: number, override: LegOverride) => void
  /** Centres the map on a point (a warning's place on the route). */
  onShowOnMap?: (lng: number, lat: number) => void
  /** Selects a leg in the route table (also highlights it on the map). */
  onSelectLeg?: (leg: number | null) => void
  /** METAR/TAF stations along the route: their own reported wind feeds the crosswind check. */
  weatherStations?: RouteWeatherStation[]
}

/** Value that follows `value` only after it has been still for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export default function PreflightWarnings(props: Props) {
  const { aircraft, aircraftId, onSetLegOverride, onShowOnMap, onSelectLeg } = props
  // Dragging a point or undo/redo changes the route many times a second; the check waits until it is still.
  const waypoints = useSettled(props.waypoints, ROUTE_SETTLE_MS)
  const legOverrides = useSettled(props.legOverrides, ROUTE_SETTLE_MS)
  const legWinds = useSettled(props.legWinds, ROUTE_SETTLE_MS)
  const windsLoading = useSettled(props.windsLoading, ROUTE_SETTLE_MS)
  const airspace = useGeo('airspace')
  const obstacles = useGeo('obstacles')
  const landmarks = useGeo('landmarks')
  const aerodromes = useGeo('aerodromes')
  const airspaceGeo = airspace.fc ?? (airspace.failed ? EMPTY_FC : null)
  const obstacleGeo = obstacles.fc ?? (obstacles.failed ? EMPTY_FC : null)
  const landmarkGeo = landmarks.fc ?? (landmarks.failed ? EMPTY_FC : null)
  const aerodromeGeo = aerodromes.fc
  const [terrainPts,  setTerrainPts]  = useState<TerrainPoint[]>([])
  const [terrainDone, setTerrainDone] = useState(false)
  const [terrainFailed, setTerrainFailed] = useState(false)

  // Fetch terrain + MSA whenever the route changes
  const routeKey = waypoints
    .map((w) => `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`)
    .join('|')

  useEffect(() => {
    if (waypoints.length < 2) {
      setTerrainPts([])
      setTerrainDone(false)
      setTerrainFailed(false)
      return
    }
    setTerrainDone(false)
    setTerrainFailed(false)
    const ctrl = new AbortController()
    fetchTerrainProfileShared(waypoints, API_BASE_URL, ctrl.signal, getRemoteDem())
      .then((pts) => {
        setTerrainPts(pts)
        setTerrainDone(true)
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') {
          setTerrainFailed(true)
          setTerrainDone(true)  // show warnings without MSA rather than hang
        }
      })
    return () => ctrl.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey])

  const [msaMargins] = useMsaMargins()
  const [alertBanners] = useAlertBanners()
  const airspaceLevels = alertBanners.airspaceLevels
  const abeamNm = resolveMsaMargins(msaMargins).abeamNm
  const rawProfile = useMemo<VirtualRadarProfile | null>(() => {
    if (waypoints.length < 2 || !airspaceGeo || !obstacleGeo) return null
    return buildVirtualRadarProfile(waypoints, legOverrides, airspaceGeo, obstacleGeo, undefined, landmarkGeo ?? undefined, Infinity, aircraft?.cruiseAltFt || undefined, { obstacleNm: abeamNm, landmarkNm: abeamNm })
  }, [waypoints, legOverrides, airspaceGeo, obstacleGeo, landmarkGeo, aircraft?.cruiseAltFt, abeamNm])
  // AGL limits lifted onto the terrain so the penetration check compares altitudes.
  const profile = useMemo(
    () => rawProfile && { ...rawProfile, airspaceBands: applyTerrainToBands(rawProfile.airspaceBands, terrainPts) },
    [rawProfile, terrainPts],
  )

  // Regional NOTAMs for the countries the route touches (restricted areas a NOTAM creates).
  const { selected: selectedRegions } = useCountries()
  const notamRegions = useMemo(
    () => notamRegionsFor({ selected: selectedRegions, route: waypoints }),
    [selectedRegions, waypoints],
  )
  const regional = useRegionalNotamsState(waypoints.length >= 2 && !!props.signedIn, notamRegions)
  const regionalNotams = regional.notams
  const vfrNotams = useMemo(() => regionalNotams.filter((n) => !isIfrOnly(n)), [regionalNotams])

  const mefGrids = useMefGrids()
  // Fetched terrain, or (once the fetch failed) route samples from the terrain grid.
  const msaTerrain = useMemo(
    () => terrainForMsa(waypoints, terrainPts, mefGrids, msaMargins, terrainFailed),
    [waypoints, terrainPts, mefGrids, msaMargins, terrainFailed],
  )
  const msaPts = useMemo<MsaPoint[]>(
    () => computeMsaProfile(msaTerrain.pts, msaMargins, profile ? obstacleTipsForMsa(profile.obstacles, profile.landmarks, (d) => terrainAt(msaTerrain.pts, d)) : undefined, msaTerrain.corridorFt),
    [msaTerrain, msaMargins, profile],
  )

  const unavailable = useMemo(() => {
    const u: PreflightUnavailable = {}
    if (airspace.failed) u.airspace = true
    if (obstacles.failed || landmarks.failed) u.obstacles = true
    if (aerodromes.failed) u.aerodromes = true
    if (!props.signedIn) u.notams = 'Sign in to check restricted areas created by NOTAM.'
    else if (regional.failed) u.notams = 'The NOTAM service could not be reached, so restricted areas created by NOTAM were not checked.'
    return u
  }, [airspace.failed, obstacles.failed, landmarks.failed, aerodromes.failed, regional.failed, props.signedIn])

  // Wind each aerodrome reports itself (not a neighbour's METAR), for the crosswind check.
  const { surfaceWinds, surfaceTempsC } = useMemo(() => {
    const winds = new Map<string, ParsedWind>()
    const temps = new Map<string, number>()
    for (const st of props.weatherStations ?? []) {
      if (!st.metar || (st.sourceIcao && st.sourceIcao !== st.icao)) continue
      const w = metarSurfaceWind(st.metar)
      if (w) winds.set(st.icao.toUpperCase(), w)
      const t = parseMetarTempC(st.metar)
      if (t != null) temps.set(st.icao.toUpperCase(), t)
    }
    return { surfaceWinds: winds, surfaceTempsC: temps }
  }, [props.weatherStations])

  const warnings = useMemo<PreflightWarning[]>(() => {
    if (!profile) return []
    return computeWarnings(profile, msaPts, aircraft, waypoints, legOverrides, aircraftId, terrainFailed, legWinds, resolveMsaMargins(msaMargins), { terrainPts, airspaceLevels, aerodromes: aerodromeGeo, notams: vfrNotams, airspace: airspaceGeo, unavailable, surfaceWinds, surfaceTempsC })
  }, [profile, msaPts, aircraft, waypoints, legOverrides, aircraftId, terrainFailed, legWinds, msaMargins, terrainPts, airspaceLevels, aerodromeGeo, vfrNotams, airspaceGeo, unavailable, surfaceWinds, surfaceTempsC])

  const prompts = useMemo(
    () => computePrompts({ waypoints, legWinds, windsLoading }),
    [waypoints, legWinds, windsLoading],
  )

  const loading = !terrainDone && waypoints.length >= 2

  if (waypoints.length < 2) return null

  return (
    <div className={css.panel}>
      {loading && (
        <p className={css.loading}>Checking route…</p>
      )}

      {!loading && !warnings.some((w) => w.level !== 'info') && (
        <div className={css.ok}>
          <span className={css.okIcon}><IconCheck size={14} aria-hidden="true" /></span>
          No issues found
        </div>
      )}

      {warnings.map((w, i) => {
        const fix = w.fix
        return (
        <div
          key={`${w.code}-${i}`}
          className={`${css.card} ${w.level === 'danger' ? css.danger : w.level === 'info' ? css.info : css.warn}`}
        >
          <div className={css.cardTitle}>
            <span className={css.cardIcon}>{w.level === 'danger' ? '✕' : w.level === 'info' ? 'i' : '!'}</span>
            {w.title}
          </div>
          <div className={css.cardDetail}>{w.detail}</div>
          {w.focusNm != null && onShowOnMap && (
            <button
              type="button"
              className={css.fixBtn}
              onClick={() => {
                if (w.legIndex != null) onSelectLeg?.(w.legIndex)
                const pt = coordinateAlongRouteNm(waypoints, w.focusNm ?? 0)
                onShowOnMap(pt.lng, pt.lat)
              }}
            >
              Show on map
            </button>
          )}
          {fix?.kind === 'raise-leg' && onSetLegOverride && (
            <button
              type="button"
              className={css.fixBtn}
              onClick={() => onSetLegOverride(fix.legIndex, { ...(props.legOverrides[fix.legIndex] ?? {}), altFt: fix.altFt })}
            >
              Raise to {fix.altFt.toLocaleString('en-US')} ft
            </button>
          )}
        </div>
        )
      })}

      {prompts.map((p) => (
        <div key={p.code} className={`${css.card} ${css.info}`}>
          <div className={css.cardTitle}>
            <span className={css.cardIcon}>i</span>
            {p.title}
          </div>
          <div className={css.cardDetail}>{p.detail}</div>
        </div>
      ))}
    </div>
  )
}
