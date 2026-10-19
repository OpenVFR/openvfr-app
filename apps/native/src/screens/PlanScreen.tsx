/**
 * PlanScreen — flight planning with fuel plan, ETE/ETA, wind, and GPX export.
 *
 * Displays:
 *   - Waypoint list with per-leg dist / magnetic heading / ETE / ETA
 *   - Global wind input (dir/speed) — affects ETE via wind correction
 *   - Takeoff time → ETAs per leg
 *   - Aircraft profile selector (if profiles exist) → full fuel plan
 *   - Fuel summary (taxi / enroute / contingency / total)
 *   - GPX export
 *
 * Waypoints are added from MapScreen (long-press or tap on feature).
 */

import React, { useMemo, useState, useEffect } from 'react'
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ScrollView, TextInput, Share, RefreshControl, Alert,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useNavigation } from '@react-navigation/native'
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons'
import * as Crypto from 'expo-crypto'

import { useRouteContext } from '../context/RouteContext'
import { useMapFocus } from '../context/MapFocusContext'
import { groupPlaces } from '../utils/places'
import { useKeyboardHeight } from '../components/NativeSheet'
import { useWeatherAlongRoute } from '../hooks/useWeatherAlongRoute'
import { tafChangeIcaos } from '@open-vfr/shared/parseTaf'
import { useRouteSync }       from '../hooks/useRouteSync'
import { useSettingsContext }  from '../context/SettingsContext'
import { useAuthContext }      from '../context/AuthContext'
import { useUserWaypointContext } from '../context/UserWaypointContext'
import { RouteLibrarySheet }  from '../components/RouteLibrarySheet'
import { AircraftEditSheet }  from '../components/AircraftEditSheet'
import { NativeSheet }        from '../components/NativeSheet'
import { useAircraftSync }    from '../hooks/useAircraftSync'
import type { AircraftProfileDocType } from '../types/db'
import { useFlightLogSync } from '../hooks/useFlightLogSync'
import { flightLogs as flightLogsDb } from '../db'
import { useFlightLogViewContext } from '../context/FlightLogViewContext'
import { useTakeoffTime, useAlternate, useGlobalWind } from '../hooks/usePlanningSettings'
import { getAerodromeLookup } from '../utils/aerodromeLookup'
import type { UserWaypointDocType } from '../types/db'
import type { LegOverride } from '../types/db'
import { distanceNm, magneticBearingDeg, bearingDeg } from '../utils/routeCalc'
import {
  computeLogStats, formatLogDuration, logTotals, logPeriodStart, LOG_PERIODS, LOG_PERIOD_LABEL,
  type LogStats, type LogPeriod,
} from '@open-vfr/shared/flightLogStats'
import { nmToDisplay, distLabel, ktsToDisplay, displayToKts, speedLabel } from '../utils/units'
import { computeFuelPlan } from '../utils/fuelCalc'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'

type Segment = 'route' | 'aircraft' | 'waypoints' | 'logs'
const SEGMENTS: { key: Segment; label: string; icon: React.ComponentProps<typeof Ionicons>['name'] }[] = [
  { key: 'route',     label: 'Route',     icon: 'navigate-outline' },
  { key: 'aircraft',  label: 'Aircraft',  icon: 'airplane-outline' },
  { key: 'waypoints', label: 'Places', icon: 'pin-outline' },
  { key: 'logs',      label: 'Logs',      icon: 'list-outline' },
]

// ── Wind correction angle (WCA) ───────────────────────────────────────────
function wcaDeg(trackDeg: number, windDir: number, windSpd: number, tas: number): number {
  if (windSpd <= 0 || tas <= 0) return 0
  const wAngle = (windDir - trackDeg + 180) % 360 - 180  // cross-wind component angle
  return Math.asin(Math.min(1, (windSpd * Math.sin(wAngle * Math.PI / 180)) / tas)) * 180 / Math.PI
}

function gsKts(trackDeg: number, windDir: number, windSpd: number, tas: number): number {
  if (windSpd <= 0 || tas <= 0) return tas
  const wAngle = (windDir - trackDeg) * Math.PI / 180
  const headwind = windSpd * Math.cos(wAngle)
  return Math.max(1, tas - headwind)
}

// ── GPX export ───────────────────────────────────────────────────────────
import type { RouteWaypoint } from '../utils/routeCalc'
import { routeToGpx, gpxToRoute, waypointsToGpx, gpxToWaypoints, flightLogToGpx, gpxToFlightLog } from '@open-vfr/shared/gpx'
import { iasToTas } from '@open-vfr/shared/airspeed'
import { useLegForecastWind, type LegWindQuery } from '../hooks/useLegForecastWind'
import * as FileSystem from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import * as DocumentPicker from 'expo-document-picker'

function fmtTime(totalMins: number): string {
  const h = Math.floor(totalMins / 60)
  const m = Math.round(totalMins % 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function fmtEta(baseMins: number, offsetMins: number): string {
  const total = baseMins + offsetMins
  const h = Math.floor((total % (24 * 60)) / 60)
  const m = Math.round(total % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}Z`
}

// ── Component ─────────────────────────────────────────────────────────────
const LOG_STATS_THR = { takeoffKts: 30, landedKts: 20 }
const logInfoCache = new Map<string, { stats: LogStats | null; summary: string }>()

type LogLike = { id: string; updatedAt: number; trackJson: string; endedAt: number; startedAt: number; maxAltFt: number }

/** Stats + "42m · 3 landings (2 T&G) · max 3,500 ft" line, derived from the stored track (cached per log revision). */
function logInfo(log: LogLike): { stats: LogStats | null; summary: string } {
  const key = `${log.id}:${log.updatedAt}`
  const hit = logInfoCache.get(key)
  if (hit) return hit
  let out: { stats: LogStats | null; summary: string } = { stats: null, summary: '' }
  try {
    const st = computeLogStats(JSON.parse(log.trackJson || '[]'), LOG_STATS_THR)
    const parts = [formatLogDuration(st.airborneMs > 0 ? st.airborneMs : log.endedAt - log.startedAt)]
    if (st.landings > 0) parts.push(`${st.landings} landing${st.landings === 1 ? '' : 's'}${st.touchAndGos > 0 ? ` (${st.touchAndGos} T&G)` : ''}`)
    if (log.maxAltFt > 0) parts.push(`max ${Math.round(log.maxAltFt).toLocaleString()} ft`)
    if (st.gapCount > 0) parts.push('⚠ gaps')
    out = { stats: st, summary: parts.join(' · ') }
  } catch { /* corrupt track: no summary */ }
  logInfoCache.set(key, out)
  return out
}

export function PlanScreen() {
  const scaledTheme = useScaledTheme()
  const styles = useThemedStyles(makeStyles)
  const insets = useSafeAreaInsets()
  const { waypoints, legOverrides, addWaypoint, insertWaypoint, removeWaypoint, clearRoute, setWaypoints, moveWaypoint, reverseRoute, setLegOverride, activeRouteId, setActiveRouteId, routeVisible, setRouteVisible } = useRouteContext()
  const { settings, update } = useSettingsContext()
  const routeWx = useWeatherAlongRoute(waypoints)
  const tafWarnIcaos = useMemo(() => tafChangeIcaos(routeWx), [routeWx])
  const { state: authState } = useAuthContext()
  const authenticated = authState.status === 'authenticated'
  const { syncState, pull: pullRoutes, pushRoute, deleteRoute } = useRouteSync(authenticated)
  const units = settings.units
  const [segment, setSegment] = useState<Segment>('route')
  // Overflow menu -- consolidates Open (Route Library) / GPX Import / GPX
  // Export / Undo, previously four separate always-visible header buttons
  // crowding the row alongside Active/Inactive, Rev, and Clear.
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)

  // Aircraft profiles — synced with cloud (user_aircraft_profiles) when authenticated
  const { profiles, pull: pullAircraft, pushAircraft, deleteAircraft } = useAircraftSync(authenticated)
  const [aircraftRefreshing, setAircraftRefreshing] = useState(false)
  const handleAircraftRefresh = async () => { setAircraftRefreshing(true); try { await pullAircraft() } finally { setAircraftRefreshing(false) } }
  const selectedId = settings.selectedAircraftId || null
  const setSelectedId = (id: string | null) => void update({ selectedAircraftId: id ?? '' })
  const profile = profiles.find(p => p.id === selectedId) ?? null
  const [aircraftEdit, setAircraftEdit] = useState<AircraftProfileDocType | null>(null)
  const [aircraftEditOpen, setAircraftEditOpen] = useState(false)
  const [aircraftDeleteId, setAircraftDeleteId] = useState<string | null>(null)
  const openNewAircraft  = () => { setAircraftEdit(null); setAircraftEditOpen(true) }
  const openEditAircraft = (p: AircraftProfileDocType) => { setAircraftEdit(p); setAircraftEditOpen(true) }
  const handleSaveAircraft = (doc: AircraftProfileDocType) => { void pushAircraft(doc) }
  const handleDeleteAircraft = (id: string) => {
    void deleteAircraft(id)
    if (selectedId === id) setSelectedId(null)
    setAircraftDeleteId(null)
  }
  const handleDuplicateAircraft = (p: AircraftProfileDocType) => {
    void pushAircraft({ ...p, id: Crypto.randomUUID(), name: `${p.name} (copy)`, updatedAt: Date.now() })
  }

  // User waypoints — synced with cloud (user_waypoints) when authenticated;
  // saving-by-map-tap now happens directly on MapScreen's long-press menu
  // (shared UserWaypointContext instance), this screen just lists/manages them
  // plus a manual-entry fallback for exact coordinates.
  const {
    syncState: waypointSyncState, waypoints: userWaypoints, pull: pullWaypoints, saveWaypoint, deleteWaypoint,
  } = useUserWaypointContext()
  const [waypointsRefreshing, setWaypointsRefreshing] = useState(false)
  const handleWaypointsRefresh = async () => { setWaypointsRefreshing(true); try { await pullWaypoints() } finally { setWaypointsRefreshing(false) } }
  const [savingWp, setSavingWp] = useState(false)
  const [wpName,   setWpName]   = useState('')
  const [wpFolder, setWpFolder] = useState('')
  const [wpLat,    setWpLat]    = useState('')
  const [wpLng,    setWpLng]    = useState('')
  // Saved-place list: search, expanded row, inline edit, delete confirm.
  const { focusMap } = useMapFocus()
  // Android is edge-to-edge (window doesn't resize), so lift the Places list by the keyboard height.
  const kbHeight = useKeyboardHeight()
  const [placeQuery,   setPlaceQuery]   = useState('')
  const [openPlaceId,  setOpenPlaceId]  = useState<string | null>(null)
  const [editPlaceId,  setEditPlaceId]  = useState<string | null>(null)
  const [editName,     setEditName]     = useState('')
  const [editFolder,   setEditFolder]   = useState('')
  const [delPlaceId,   setDelPlaceId]   = useState<string | null>(null)
  const [insertPlaceId, setInsertPlaceId] = useState<string | null>(null)
  const placeFolders = useMemo(
    () => [...new Set(userWaypoints.map(w => (w.folder ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [userWaypoints],
  )
  const placeGroups = useMemo(() => {
    const q = placeQuery.trim().toLowerCase()
    const list = q
      ? userWaypoints.filter(w => w.name.toLowerCase().includes(q) || (w.folder ?? '').toLowerCase().includes(q))
      : userWaypoints
    return groupPlaces(list)
  }, [userWaypoints, placeQuery])
  const placeToRoutePoint = (w: UserWaypointDocType) => ({ lat: w.lat, lng: w.lng, name: w.name })
  const startRouteAt = (w: UserWaypointDocType) => { setWaypoints([placeToRoutePoint(w)], [{}]); setSegment('route') }
  const appendToRoute = (w: UserWaypointDocType) => { addWaypoint(placeToRoutePoint(w)); setSegment('route') }
  const insertIntoRoute = (w: UserWaypointDocType, afterIdx: number) => { insertWaypoint(afterIdx, placeToRoutePoint(w)); setInsertPlaceId(null); setSegment('route') }
  const showPlaceOnMap = (w: UserWaypointDocType) => { focusMap(w.lat, w.lng, 13); navigation.navigate('Map' as never) }
  const beginEditPlace = (w: UserWaypointDocType) => { setEditPlaceId(w.id); setEditName(w.name); setEditFolder((w.folder ?? '').trim()); setDelPlaceId(null) }
  const commitEditPlace = (w: UserWaypointDocType) => {
    const name = editName.trim()
    if (!name) return
    saveWaypoint({ ...w, name, folder: editFolder.trim(), updatedAt: Date.now() })
    setEditPlaceId(null)
  }

  // Flight logs — auto-recorded on the map (GPS takeoff/landing detection),
  // synced to cloud (upload-only + cross-device pull) when authenticated.
  const { logs, pull: pullLogs, deleteLog, pushLog, refresh: refreshLogs } = useFlightLogSync(authenticated)
  const { selectedLog, viewLog, clearView } = useFlightLogViewContext()
  const navigation = useNavigation()
  const [logDeleteId, setLogDeleteId] = useState<string | null>(null)
  const [logPeriod, setLogPeriod] = useState<LogPeriod>('all')
  const [logReg, setLogReg] = useState('')  // '' = all aircraft
  const logRegistrations = useMemo(
    () => [...new Set(logs.map(l => l.registration).filter(Boolean))].sort(),
    [logs],
  )
  const shownLogs = useMemo(() => {
    const from = logPeriodStart(logPeriod)
    return [...logs]
      .filter(l => l.startedAt >= from && (!logReg || l.registration === logReg))
      .sort((a, b) => b.startedAt - a.startedAt)
  }, [logs, logPeriod, logReg])
  const logSummaryTotals = useMemo(
    () => logTotals(shownLogs.filter(l => l.endedAt > 0).map(l => ({ ...l, stats: logInfo(l).stats }))),
    [shownLogs],
  )
  const handleImportLog = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ['application/gpx+xml', '*/*'], copyToCacheDirectory: true })
      if (res.canceled || !res.assets?.[0]) return
      const doc = {
        ...gpxToFlightLog(await new FileSystem.File(res.assets[0].uri).text(), Crypto.randomUUID()),
        // A GPX file carries no aircraft: attribute it to the selected profile.
        ...(profile ? { aircraftId: profile.id, registration: profile.registration ?? '' } : {}),
      }
      // Same start and end as an existing log = the same flight imported twice.
      if (logs.some(l => l.startedAt === doc.startedAt && l.endedAt === doc.endedAt)) {
        Alert.alert('Already imported', 'This flight is already in your logs.')
        return
      }
      await flightLogsDb.upsert(doc)
      await refreshLogs()
      void pushLog(doc)
    } catch (e) {
      Alert.alert('Import failed', e instanceof Error ? e.message : 'Could not read this GPX file.')
    }
  }

  const handleExportLog = async (log: (typeof logs)[number]) => {
    try {
      const { filename, xml } = flightLogToGpx(log)
      const file = new FileSystem.File(FileSystem.Paths.cache, filename)
      if (file.exists) file.delete()
      file.create()
      file.write(xml)
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, { mimeType: 'application/gpx+xml', dialogTitle: 'Export flight as GPX' })
      }
    } catch (e) {
      Alert.alert('Export failed', e instanceof Error ? e.message : String(e))
    }
  }

  const handleViewLog = (log: (typeof logs)[number]) => {
    if (selectedLog?.id === log.id) { clearView(); return }
    viewLog(log)
    navigation.navigate('Map' as never)
  }
  const [logsRefreshing, setLogsRefreshing] = useState(false)
  const handleLogsRefresh = async () => { setLogsRefreshing(true); try { await pullLogs() } finally { setLogsRefreshing(false) } }

  // Global wind, takeoff time, alternate — persisted (same DB keys as web)
  const [wind, setGlobalWind] = useGlobalWind()
  const [windDir, setWindDir] = useState(wind ? String(wind.dirDeg) : '')
  const [windSpd, setWindSpd] = useState(wind ? String(Math.round(ktsToDisplay(wind.speedKts, units.speed))) : '')
  function commitWind() {
    const d = parseFloat(windDir); const s = parseFloat(windSpd)
    if (!isNaN(d) && !isNaN(s) && s >= 0) setGlobalWind({ dirDeg: ((Math.round(d) % 360) + 360) % 360, speedKts: displayToKts(s, units.speed) })
    else if (windDir.trim() === '' && windSpd.trim() === '') setGlobalWind(null)
  }

  const [takeoffTime, setTakeoffTime] = useTakeoffTime()
  const [takeoffStr, setTakeoffStr] = useState('')
  useEffect(() => {
    if (takeoffTime) {
      const h = String(takeoffTime.getUTCHours()).padStart(2, '0')
      const m = String(takeoffTime.getUTCMinutes()).padStart(2, '0')
      setTakeoffStr(`${h}:${m}`)
    }
  }, [takeoffTime])
  const takeoffMins = useMemo(() => {
    const m = takeoffStr.match(/^(\d{1,2}):(\d{2})$/)
    if (!m) return null
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
  }, [takeoffStr])
  function commitTakeoff() {
    if (takeoffMins == null) { setTakeoffTime(null); return }
    const d = new Date()
    d.setUTCHours(Math.floor(takeoffMins / 60), takeoffMins % 60, 0, 0)
    setTakeoffTime(d)
  }

  // Alternate destination
  const [alternate, setAlternate] = useAlternate()
  const [altInput, setAltInput] = useState('')
  const [altError, setAltError] = useState('')
  const [altLoading, setAltLoading] = useState(false)
  async function handleAltSubmit() {
    const token = altInput.trim().toUpperCase()
    if (!token) return
    setAltLoading(true); setAltError('')
    try {
      const lookup = await getAerodromeLookup()
      const match = lookup.get(token)
      if (match) { setAlternate({ icao: token, name: match.name, lng: match.lng, lat: match.lat }); setAltInput('') }
      else setAltError(`Unknown: ${token}`)
    } finally { setAltLoading(false) }
  }

  // Per-leg properties editor (altitude / speed / wind override)
  const [activeLeg, setActiveLeg] = useState<number | null>(null)
  const [ovrAlt, setOvrAlt]   = useState('')
  const [ovrSpd, setOvrSpd]   = useState('')
  const [ovrWDir, setOvrWDir] = useState('')
  const [ovrWSpd, setOvrWSpd] = useState('')
  // 'auto' = no leg wind override (global wind, else forecast); 'manual' = saved leg override.
  const [ovrWindMode, setOvrWindMode] = useState<'auto' | 'manual'>('auto')
  function openLegProps(i: number) {
    const o = legOverrides[i] ?? {}
    setOvrAlt(o.altFt != null ? String(o.altFt) : '')
    setOvrSpd(o.speedKts != null ? String(Math.round(ktsToDisplay(o.speedKts, units.speed))) : '')
    setOvrWDir(o.windDir != null ? String(o.windDir) : '')
    setOvrWSpd(o.windSpd != null ? String(Math.round(ktsToDisplay(o.windSpd, units.speed))) : '')
    setOvrWindMode(o.windDir != null || o.windSpd != null ? 'manual' : 'auto')
    setActiveLeg(i !== activeLeg ? i : null)
  }
  function saveLegProps(i: number) {
    const next: LegOverride = {}
    const alt = parseFloat(ovrAlt); if (!isNaN(alt)) next.altFt = alt
    const spd = parseFloat(ovrSpd); if (!isNaN(spd)) next.speedKts = displayToKts(spd, units.speed)
    // Auto wind (forecast/global) is never frozen into the leg — only a manual entry is saved.
    const wd  = ovrWindMode === 'manual' ? parseFloat(ovrWDir) : NaN; if (!isNaN(wd)) next.windDir = ((Math.round(wd) % 360) + 360) % 360
    const ws  = ovrWindMode === 'manual' ? parseFloat(ovrWSpd) : NaN; if (!isNaN(ws)) next.windSpd = displayToKts(ws, units.speed)
    setLegOverride(i, next)
    setActiveLeg(null)
  }

  // Cruise IAS — from profile or fallback to 90 kts. Converted to TAS at each leg's altitude below.
  const cruiseIas = profile?.cruiseIas ?? 90
  const cruiseAltFt = profile?.cruiseAltFt || 3500

  // Forecast wind per leg (SkyDemon-style): leg midpoint, altitude and expected time
  // (takeoff time, or now when unset, plus still-air time flown so far). Per-leg manual
  // wind and the global wind take precedence over it.
  const legWindQueries = useMemo<LegWindQuery[]>(() => {
    const startMs = (takeoffTime ?? new Date()).getTime()
    let cumMin = 0
    return waypoints.slice(0, -1).map((from, i) => {
      const to  = waypoints[i + 1]
      const ovr = legOverrides[i]
      const alt = ovr?.altFt ?? cruiseAltFt
      const tas = iasToTas(ovr?.speedKts ?? cruiseIas, alt)
      const legMin = tas > 0 ? (distanceNm(from, to) / tas) * 60 : 0
      const q = { lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2, altFt: alt, at: new Date(startMs + (cumMin + legMin / 2) * 60_000) }
      cumMin += legMin
      return q
    })
  }, [waypoints, legOverrides, cruiseIas, cruiseAltFt, takeoffTime])
  const { winds: forecastWinds, loading: forecastLoading, error: forecastError, refresh: refreshForecast } =
    useLegForecastWind(legWindQueries, !wind)

  // Keep the wind fields on the auto wind (global / forecast) until the pilot types an override.
  const activeAutoWind = activeLeg != null ? (wind ? { dirDeg: wind.dirDeg, speedKts: wind.speedKts } : forecastWinds[activeLeg] ?? null) : null
  useEffect(() => {
    if (activeLeg == null || ovrWindMode !== 'auto') return
    setOvrWDir(activeAutoWind ? String(Math.round(activeAutoWind.dirDeg)) : '')
    setOvrWSpd(activeAutoWind ? String(Math.round(ktsToDisplay(activeAutoWind.speedKts, units.speed))) : '')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLeg, ovrWindMode, activeAutoWind?.dirDeg, activeAutoWind?.speedKts, units.speed])

  // Per-leg summaries — per-leg override (altitude/speed/wind) takes precedence
  // over global wind/cruise TAS, mirroring web's RoutePlan legResults calc.
  const legs = useMemo(() => {
    return waypoints.slice(0, -1).map((from, i) => {
      const to      = waypoints[i + 1]
      const ovr     = legOverrides[i]
      const distNm  = distanceNm(from, to)
      const trueHdg = bearingDeg(from, to)
      const magHdg  = magneticBearingDeg(from, to)
      const tas     = iasToTas(ovr?.speedKts ?? cruiseIas, ovr?.altFt ?? cruiseAltFt)
      const fw      = forecastWinds[i]
      const effDir  = ovr?.windDir  ?? wind?.dirDeg ?? fw?.dirDeg
      const effSpd  = ovr?.windSpd  ?? wind?.speedKts ?? fw?.speedKts
      const hasWind = effDir != null && effSpd != null && effSpd > 0
      const wca     = hasWind ? wcaDeg(trueHdg, effDir!, effSpd!, tas) : 0
      const gs      = hasWind ? gsKts(trueHdg, effDir!, effSpd!, tas) : tas
      const eteMins = gs > 0 ? (distNm / gs) * 60 : null
      return { from, to, distNm, magHdg, wca, gs, tas, eteMins, index: i, altFt: ovr?.altFt }
    })
  }, [waypoints, wind, forecastWinds, cruiseIas, cruiseAltFt, legOverrides])

  const totalNm   = legs.reduce((s, l) => s + l.distNm, 0)
  const totalMins = legs.reduce((s, l) => s + (l.eteMins ?? 0), 0)

  // Cumulative ETA per waypoint
  const etas = useMemo(() => {
    if (takeoffMins === null) return null
    const cumMins: number[] = [0]
    for (const leg of legs) {
      cumMins.push(cumMins[cumMins.length - 1] + (leg.eteMins ?? 0))
    }
    return cumMins.map(offset => fmtEta(takeoffMins, offset))
  }, [takeoffMins, legs])

  // Fuel plan
  const fuelPlan = useMemo(() => {
    if (!profile || waypoints.length < 2) return null
    // Legs without a manual wind use the global wind, else the forecast (same as the leg table above).
    const legWinds = forecastWinds.map(fw => (wind ? { dirDeg: wind.dirDeg, speedKts: wind.speedKts } : fw))
    return computeFuelPlan(waypoints, legOverrides, profile, legWinds)
  }, [profile, waypoints, legOverrides, wind, forecastWinds])

  // ── Actions ──────────────────────────────────────────────────────────────
  const handleRemove = (index: number) => removeWaypoint(index)

  const handleClear = () => {
    if (waypoints.length === 0) return
    clearRoute()
  }

  const handleExportGpx = async () => {
    if (waypoints.length < 2) return
    try {
      await Share.share({ title: 'route.gpx', message: routeToGpx(waypoints, 'Route') })
    } catch { /* user cancelled */ }
  }

  const handleImportRouteGpx = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ['application/gpx+xml', '*/*'], copyToCacheDirectory: true })
      if (res.canceled || !res.assets?.[0]) return
      const text = await new FileSystem.File(res.assets[0].uri).text()
      const { waypoints: wps } = gpxToRoute(text)
      if (wps.length === 0) throw new Error('No waypoints found in GPX file')
      setWaypoints(wps, wps.map(() => ({})))
    } catch { /* invalid GPX — ignore silently */ }
  }

  const handleExportWaypointsGpx = async () => {
    if (userWaypoints.length === 0) return
    try {
      await Share.share({ title: 'user-waypoints.gpx', message: waypointsToGpx(userWaypoints) })
    } catch { /* user cancelled */ }
  }

  const handleImportWaypointsGpx = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ['application/gpx+xml', '*/*'], copyToCacheDirectory: true })
      if (res.canceled || !res.assets?.[0]) return
      const text = await new FileSystem.File(res.assets[0].uri).text()
      const imported = gpxToWaypoints(text)
      for (const wp of imported) {
        saveWaypoint({ id: Crypto.randomUUID(), name: wp.name, lat: wp.lat, lng: wp.lng, folder: wp.folder ?? '', updatedAt: Date.now() })
      }
    } catch { /* invalid GPX — ignore silently */ }
  }

  const handleSaveWaypoint = () => {
    const lat = parseFloat(wpLat); const lng = parseFloat(wpLng)
    if (isNaN(lat) || isNaN(lng) || !wpName.trim()) return
    saveWaypoint({
      id:        Crypto.randomUUID(),
      name:      wpName.trim(),
      lat, lng,
      folder:    wpFolder.trim(),
      updatedAt: Date.now(),
    })
    setWpName(''); setWpFolder(''); setWpLat(''); setWpLng(''); setSavingWp(false)
  }

  // Standard native header: back button + title come from the navigator; the
  // route actions live in its right slot.
  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: segment === 'route' ? () => (
        <View style={styles.headerActions}>
            {waypoints.length > 0 && (
              <TouchableOpacity
                onPress={() => setRouteVisible(v => !v)}
                style={[styles.headerBtn, !routeVisible && styles.headerBtnInactive]}
              >
                <MaterialCommunityIcons
                  name="map-marker-path"
                  size={14}
                  color={routeVisible ? theme.textPrimary : '#ffffff'}
                />
                <Text style={[styles.headerBtnTxt, !routeVisible && styles.headerBtnTxtInactive]}>
                  {routeVisible ? ' Active' : ' Inactive'}
                </Text>
              </TouchableOpacity>
            )}
            {/* Overflow menu -- Open (Route Library) / Undo / Export / Import /
                Reverse / Clear, previously six separate always-visible buttons here. */}
            <TouchableOpacity onPress={() => setMoreMenuOpen(true)} testID="plan-more-open" style={styles.moreBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="ellipsis-horizontal" size={14} color={theme.accentBlue} />
            </TouchableOpacity>
        </View>
      ) : undefined,
    })
  })

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      {segment === 'route' && (
        <RouteLibrarySheet
          waypoints={waypoints}
          legOverrides={legOverrides}
          aircraftId={selectedId ?? ''}
          aircraftProfiles={profiles}
          activeRouteId={activeRouteId}
          onActiveRouteIdChange={setActiveRouteId}
          syncState={syncState}
          onLoad={(route) => {
            setWaypoints(route.waypoints, route.legOverrides)
            // Only switch the active aircraft when the loaded route actually
            // has one stored — an empty aircraftId means "not recorded", not
            // "explicitly none", so keep whatever's currently selected
            // (mirrors web's MapView.tsx onLoadRoute behaviour).
            if (route.aircraftId) setSelectedId(route.aircraftId)
          }}
          onPush={pushRoute}
          onDelete={deleteRoute}
          onRefreshCloud={pullRoutes}
          open={libraryOpen}
          onOpenChange={setLibraryOpen}
          hideTrigger
        />
      )}

      <NativeSheet
        isPresented={moreMenuOpen}
        onDismiss={() => setMoreMenuOpen(false)}
        title="Route actions"
        testID="plan-more-sheet"
      >
        <TouchableOpacity
          style={styles.moreMenuItem}
          onPress={() => { setMoreMenuOpen(false); setLibraryOpen(true) }}
          testID="plan-open-library"
        >
          <Ionicons name="folder-outline" size={16} color={theme.textSecondary} />
          <Text style={styles.moreMenuItemTxt}>Route Library…</Text>
        </TouchableOpacity>
        {waypoints.length >= 2 && (
          <TouchableOpacity
            style={styles.moreMenuItem}
            onPress={() => { setMoreMenuOpen(false); handleExportGpx() }}
          >
            <Ionicons name="download-outline" size={16} color={theme.textSecondary} />
            <Text style={styles.moreMenuItemTxt}>Export GPX</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={styles.moreMenuItem}
          onPress={() => { setMoreMenuOpen(false); handleImportRouteGpx() }}
        >
          <Ionicons name="cloud-upload-outline" size={16} color={theme.textSecondary} />
          <Text style={styles.moreMenuItemTxt}>Import GPX</Text>
        </TouchableOpacity>
        {waypoints.length >= 2 && (
          <TouchableOpacity
            style={styles.moreMenuItem}
            onPress={() => { setMoreMenuOpen(false); reverseRoute() }}
          >
            <Ionicons name="swap-vertical-outline" size={16} color={theme.textSecondary} />
            <Text style={styles.moreMenuItemTxt}>Reverse Route</Text>
          </TouchableOpacity>
        )}
        {waypoints.length > 0 && (
          <TouchableOpacity
            style={styles.moreMenuItem}
            onPress={() => { setMoreMenuOpen(false); handleClear() }}
          >
            <Ionicons name="trash-outline" size={16} color={theme.accentRed} />
            <Text style={[styles.moreMenuItemTxt, { color: theme.accentRed }]}>Clear Route</Text>
          </TouchableOpacity>
        )}
      </NativeSheet>

      {/* Segmented sub-nav */}
      <View style={styles.segmentRow}>
        {SEGMENTS.map(s => (
          <TouchableOpacity
            key={s.key}
            style={[styles.segmentBtn, segment === s.key && styles.segmentBtnActive]}
            onPress={() => setSegment(s.key)}
          >
            {s.key === 'route' ? (
              <MaterialCommunityIcons name="map-marker-path" size={18} color={segment === s.key ? theme.accentBlue : theme.textMuted} />
            ) : (
              <Ionicons name={s.icon} size={18} color={segment === s.key ? theme.accentBlue : theme.textMuted} />
            )}
            <Text style={[styles.segmentTxt, segment === s.key && styles.segmentTxtActive]}>{s.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {segment === 'route' && (
      <ScrollView showsVerticalScrollIndicator={false}>

        {/* ── Planning inputs ─────────────────────────────────────── */}
        {waypoints.length >= 2 && (
          <View style={styles.inputsCard}>
            {/* Wind */}
            <View style={styles.inputRow}>
              <Text style={styles.inputLabel}>Wind</Text>
              <View style={styles.windInputs}>
                <TextInput
                  style={styles.numberInput}
                  value={windDir}
                  onChangeText={setWindDir}
                  onBlur={commitWind}
                  placeholder="Dir°"
                  placeholderTextColor={theme.textFaint}
                  keyboardType="numeric"
                  maxLength={3}
                />
                <Text style={styles.inputSep}>/</Text>
                <TextInput
                  style={styles.numberInput}
                  value={windSpd}
                  onChangeText={setWindSpd}
                  onBlur={commitWind}
                  placeholder={speedLabel(units.speed)}
                  placeholderTextColor={theme.textFaint}
                  keyboardType="numeric"
                  maxLength={3}
                />
                {!wind && (
                  <TouchableOpacity onPress={refreshForecast}>
                    <Text style={styles.clearBtn}>{forecastLoading ? 'FCST …' : forecastError ? 'no FCST ↻' : 'FCST ↻'}</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>

            {/* Takeoff time */}
            <View style={styles.inputRow}>
              <Text style={styles.inputLabel}>Takeoff (UTC)</Text>
              <TextInput
                style={styles.numberInput}
                value={takeoffStr}
                onChangeText={setTakeoffStr}
                onBlur={commitTakeoff}
                placeholder="HH:MM"
                placeholderTextColor={theme.textFaint}
                keyboardType="numeric"
                maxLength={5}
              />
            </View>

            {/* Alternate destination */}
            <View style={styles.inputRow}>
              <Text style={styles.inputLabel}>Alternate</Text>
              {alternate ? (
                <View style={styles.windInputs}>
                  <Text style={styles.altSetTxt}>{alternate.icao}</Text>
                  <TouchableOpacity onPress={() => setAlternate(null)}>
                    <Text style={styles.clearBtn}>✕</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.windInputs}>
                  <TextInput
                    style={styles.numberInput}
                    value={altInput}
                    onChangeText={(t) => { setAltInput(t.toUpperCase()); setAltError('') }}
                    placeholder="ICAO"
                    placeholderTextColor={theme.textFaint}
                    autoCapitalize="characters"
                    maxLength={6}
                  />
                  <TouchableOpacity onPress={handleAltSubmit} style={styles.headerBtn} disabled={altLoading || !altInput.trim()}>
                    <Text style={styles.headerBtnTxt}>{altLoading ? '…' : 'Set'}</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
            {altError !== '' && <Text style={styles.legWca}>{altError}</Text>}
          </View>
        )}

        {/* ── Empty state ─────────────────────────────────────────── */}
        {waypoints.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No route points</Text>
            <Text style={styles.emptyBody}>
              Long-press the map or tap aerodromes, navaids, and waypoints on the map to build a route.
            </Text>
          </View>
        )}

        {/* ── Waypoint / leg list ─────────────────────────────────── */}
        {waypoints.map((wp, index) => {
          const leg = index < legs.length ? legs[index] : null
          const eta = etas?.[index] ?? null
          const hasOverride = !!(legOverrides[index]?.altFt || legOverrides[index]?.speedKts || legOverrides[index]?.windDir || legOverrides[index]?.windSpd)
          return (
            <View key={index}>
              <View style={styles.wpRow}>
                <View style={styles.reorderCol}>
                  <TouchableOpacity disabled={index === 0} onPress={() => moveWaypoint(index, index - 1)}>
                    <Ionicons name="chevron-up" size={14} color={index === 0 ? theme.textFaint : theme.textMuted} />
                  </TouchableOpacity>
                  <TouchableOpacity disabled={index === waypoints.length - 1} onPress={() => moveWaypoint(index, index + 1)}>
                    <Ionicons name="chevron-down" size={14} color={index === waypoints.length - 1 ? theme.textFaint : theme.textMuted} />
                  </TouchableOpacity>
                </View>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{index + 1}</Text>
                </View>
                <View style={styles.wpInfo}>
                  <Text style={styles.wpName}>
                    {wp.name ?? `${wp.lat.toFixed(3)}°N`}
                    {wp.name && tafWarnIcaos.includes(wp.name) ? <Text style={styles.wpTafWarn}>{' \u26a0'}</Text> : null}
                  </Text>
                  {eta && <Text style={styles.wpEta}>{eta}</Text>}
                  {wp.note ? <Text style={styles.wpNote} numberOfLines={1}>📌 {wp.note}</Text> : null}
                </View>
                <TouchableOpacity style={styles.removeBtn} onPress={() => handleRemove(index)}>
                  <Text style={styles.removeBtnText}>✕</Text>
                </TouchableOpacity>
              </View>
              {leg && (
                <TouchableOpacity
                  style={[styles.legCol, hasOverride && styles.legColSet]}
                  onPress={() => openLegProps(index)}
                  accessibilityLabel={`Edit leg ${index + 1} properties`}
                >
                  <Ionicons name="arrow-down" size={14} color={hasOverride ? theme.accentBlue : theme.textFaint} />
                  <View style={styles.legStats}>
                    <Text style={styles.legDist}>
                      {nmToDisplay(leg.distNm, units.distance).toFixed(1)} {distLabel(units.distance)}
                    </Text>
                    <Text style={[styles.legHdg, hasOverride && styles.legHdgSet]}>{Math.round(leg.magHdg).toString().padStart(3, '0')}°M</Text>
                    {leg.eteMins != null && <Text style={styles.legEte}>{fmtTime(leg.eteMins)}</Text>}
                    {leg.altFt != null && <Text style={styles.legWca}>{Math.round(leg.altFt)} ft</Text>}
                    <Text style={styles.legWca}>TAS {Math.round(ktsToDisplay(leg.tas, units.speed))}</Text>
                    {Math.abs(leg.wca) >= 1 && (
                      <Text style={styles.legWca}>WCA {leg.wca > 0 ? '+' : ''}{Math.round(leg.wca)}°</Text>
                    )}
                  </View>
                  <Ionicons name="create-outline" size={14} color={hasOverride ? theme.accentBlue : theme.textFaint} />
                </TouchableOpacity>
              )}
              {activeLeg === index && leg && (
                <View style={styles.legPropsPanel}>
                  <Text style={styles.cardTitle}>Leg {index + 1}: override</Text>
                  <View style={styles.windInputs}>
                    <TextInput style={styles.numberInput} value={ovrAlt} onChangeText={setOvrAlt} placeholder="Alt ft" placeholderTextColor={theme.textFaint} keyboardType="numeric" />
                    <TextInput style={styles.numberInput} value={ovrSpd} onChangeText={setOvrSpd} placeholder={`IAS ${speedLabel(units.speed)}`} placeholderTextColor={theme.textFaint} keyboardType="numeric" />
                  </View>
                  <View style={styles.windInputs}>
                    <TextInput style={styles.numberInput} value={ovrWDir} onChangeText={(t) => { setOvrWindMode('manual'); setOvrWDir(t) }} placeholder="Wind Dir°" placeholderTextColor={theme.textFaint} keyboardType="numeric" />
                    <TextInput style={styles.numberInput} value={ovrWSpd} onChangeText={(t) => { setOvrWindMode('manual'); setOvrWSpd(t) }} placeholder={`Wind ${speedLabel(units.speed)}`} placeholderTextColor={theme.textFaint} keyboardType="numeric" />
                  </View>
                  <View style={styles.saveRowActions}>
                    <Text style={styles.inputLabel}>
                      {ovrWindMode === 'manual' ? 'Wind: manual' : wind ? 'Wind: global' : forecastWinds[index] ? 'Wind: forecast' : forecastLoading ? 'Wind: loading…' : 'Wind: no forecast'}
                    </Text>
                    {ovrWindMode === 'manual' && (
                      <TouchableOpacity onPress={() => setOvrWindMode('auto')}>
                        <Text style={styles.clearBtn}>Reset to {wind ? 'global' : 'forecast'}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  <View style={styles.saveRowActions}>
                    <TouchableOpacity style={styles.saveConfirm} onPress={() => saveLegProps(index)}>
                      <Text style={styles.saveConfirmTxt}>Save</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setActiveLeg(null)}>
                      <Text style={styles.clearBtn}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
              {index < waypoints.length - 1 && <View style={styles.separator} />}
            </View>
          )
        })}

        {/* ── Totals ──────────────────────────────────────────────── */}
        {waypoints.length >= 2 && (
          <View style={styles.totalsCard}>
            <Row label="Distance" value={`${nmToDisplay(totalNm, units.distance).toFixed(1)} ${distLabel(units.distance)}`} />
            {totalMins > 0 && <Row label="Total ETE" value={fmtTime(totalMins)} />}
            {etas && takeoffMins !== null && (
              <Row label="ETA dest" value={fmtEta(takeoffMins, totalMins)} accent />
            )}
          </View>
        )}

        {/* ── Fuel plan ───────────────────────────────────────────── */}
        {fuelPlan && (
          <View style={styles.fuelCard}>
            <Text style={styles.cardTitle}>Fuel Plan</Text>
            <Row label="Taxi"         value={`${fuelPlan.taxiFuelL.toFixed(1)} L`} />
            <Row label="Enroute"      value={`${fuelPlan.enrouteFuelL.toFixed(1)} L`} />
            <Row label="Contingency"  value={`${fuelPlan.contingencyFuelL.toFixed(1)} L  (${fuelPlan.contingencyPct}%)`} />
            <Row label="Reserve"      value={`${(fuelPlan.holdingFuelL + fuelPlan.landingFuelL).toFixed(1)} L`} />
            <View style={styles.fuelDivider} />
            <Row
              label="Total required"
              value={`${fuelPlan.totalMinFuelL.toFixed(1)} L`}
              accent
              bold
            />
            {fuelPlan.availableFuelL > 0 && (
              <Row
                label="Available"
                value={`${fuelPlan.availableFuelL.toFixed(1)} L`}
                accent={fuelPlan.availableFuelL >= fuelPlan.totalMinFuelL}
                warn={fuelPlan.availableFuelL < fuelPlan.totalMinFuelL}
              />
            )}
          </View>
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
      )}

      {segment === 'aircraft' && (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: scaledTheme.space3 }}
          refreshControl={<RefreshControl refreshing={aircraftRefreshing} onRefresh={handleAircraftRefresh} tintColor={theme.accentBlue} />}
        >
          <TouchableOpacity style={styles.saveBtn} onPress={openNewAircraft}>
            <Ionicons name="add-circle-outline" size={14} color={theme.accentBlue} />
            <Text style={styles.saveBtnTxt}>Add Aircraft…</Text>
          </TouchableOpacity>
          <View style={{ height: scaledTheme.space2 }} />
          {profiles.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No aircraft profiles</Text>
              <Text style={styles.emptyBody}>
                Add an aircraft above, or sign in to sync profiles created on the web app.
              </Text>
            </View>
          ) : (
            profiles.map(p => {
              const active = p.id === selectedId
              return (
                <View key={p.id} style={[styles.aircraftRow, active && styles.aircraftRowActive]}>
                  <TouchableOpacity style={styles.aircraftInfo} onPress={() => setSelectedId(active ? null : p.id)}>
                    <Text style={styles.aircraftName}>
                      {p.registration || p.name} <Text style={styles.categoryBadge}>{p.category ?? 'SEP'}</Text>
                    </Text>
                    <Text style={styles.aircraftMeta}>
                      {p.icaoType} · {p.cruiseIas} kt{p.category !== 'GLIDER' ? ` · ${p.fuelBurnLhr.toFixed(1)} L/hr` : ''}
                    </Text>
                  </TouchableOpacity>
                  <View style={styles.aircraftActions}>
                    {active && <Ionicons name="checkmark-circle" size={16} color={theme.accentBlue} style={{ marginRight: 4 }} />}
                    {aircraftDeleteId === p.id ? (
                      <>
                        <TouchableOpacity style={styles.removeBtn} onPress={() => handleDeleteAircraft(p.id)}>
                          <Ionicons name="checkmark" size={16} color={theme.statusDanger} />
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.removeBtn} onPress={() => setAircraftDeleteId(null)}>
                          <Ionicons name="close" size={16} color={theme.textMuted} />
                        </TouchableOpacity>
                      </>
                    ) : (
                      <>
                        <TouchableOpacity style={styles.removeBtn} onPress={() => openEditAircraft(p)}>
                          <Ionicons name="pencil-outline" size={14} color={theme.textMuted} />
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.removeBtn} onPress={() => handleDuplicateAircraft(p)}>
                          <Ionicons name="copy-outline" size={14} color={theme.textMuted} />
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.removeBtn} onPress={() => setAircraftDeleteId(p.id)}>
                          <Ionicons name="trash-outline" size={14} color={theme.statusDanger} />
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                </View>
              )
            })
          )}
        </ScrollView>
      )}

      <AircraftEditSheet
        profile={aircraftEdit}
        visible={aircraftEditOpen}
        onClose={() => setAircraftEditOpen(false)}
        onSave={handleSaveAircraft}
      />

      {segment === 'waypoints' && (
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: scaledTheme.space3, paddingBottom: scaledTheme.space3 + kbHeight }}
          refreshControl={<RefreshControl refreshing={waypointsRefreshing} onRefresh={handleWaypointsRefresh} tintColor={theme.accentBlue} />}
        >
          <View style={styles.saveSection}>
            <View style={{ flexDirection: 'row', gap: scaledTheme.space2, marginBottom: scaledTheme.space2 }}>
              <TouchableOpacity onPress={handleImportWaypointsGpx} style={styles.headerBtn}>
                <Text style={styles.headerBtnTxt}>GPX ↑ Import</Text>
              </TouchableOpacity>
              {userWaypoints.length > 0 && (
                <TouchableOpacity onPress={handleExportWaypointsGpx} style={styles.headerBtn}>
                  <Text style={styles.headerBtnTxt}>GPX ↓ Export</Text>
                </TouchableOpacity>
              )}
            </View>
            {!savingWp ? (
              <View style={{ gap: scaledTheme.space2 }}>
                <Text style={styles.emptyBody}>
                  Tip: long-press anywhere on the map to save that point as a place.
                </Text>
                <TouchableOpacity style={styles.saveBtn} onPress={() => setSavingWp(true)}>
                  <Ionicons name="add-circle-outline" size={14} color={theme.accentBlue} />
                  <Text style={styles.saveBtnTxt}>Enter coordinates manually…</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={{ gap: scaledTheme.space2 }}>
                <TextInput
                  style={styles.numberInput}
                  value={wpName}
                  onChangeText={setWpName}
                  placeholder="Name"
                  placeholderTextColor={theme.textFaint}
                  autoFocus
                />
                <View style={styles.windInputs}>
                  <TextInput
                    style={styles.numberInput}
                    value={wpLat}
                    onChangeText={setWpLat}
                    placeholder="Lat"
                    placeholderTextColor={theme.textFaint}
                    keyboardType="numbers-and-punctuation"
                  />
                  <TextInput
                    style={styles.numberInput}
                    value={wpLng}
                    onChangeText={setWpLng}
                    placeholder="Lng"
                    placeholderTextColor={theme.textFaint}
                    keyboardType="numbers-and-punctuation"
                  />
                </View>
                <TextInput
                  style={styles.numberInput}
                  value={wpFolder}
                  onChangeText={setWpFolder}
                  placeholder="Folder (optional)"
                  placeholderTextColor={theme.textFaint}
                />
                <Text style={styles.inputHint}>
                  Tip: long-press a point on the map to read its coordinates and save it.
                </Text>
                <View style={styles.saveRowActions}>
                  <TouchableOpacity style={styles.saveConfirm} onPress={handleSaveWaypoint}>
                    <Text style={styles.saveConfirmTxt}>Save</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setSavingWp(false)}>
                    <Text style={styles.clearBtn}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>

          {userWaypoints.length > 0 && (
            <TextInput
              style={[styles.numberInput, { marginBottom: scaledTheme.space2 }]}
              value={placeQuery}
              onChangeText={setPlaceQuery}
              placeholder="Search places or folders"
              placeholderTextColor={theme.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
            />
          )}
          {userWaypoints.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No saved places</Text>
              <Text style={styles.emptyBody}>Save places to reuse across routes and devices.</Text>
            </View>
          ) : placeGroups.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyBody}>No places match “{placeQuery}”.</Text>
            </View>
          ) : (
            placeGroups.map(g => (
              <View key={g.folder || '__none'}>
                {(placeGroups.length > 1 || g.folder) && (
                  <View style={styles.placeFolderHdr}>
                    <Ionicons name="folder-outline" size={13} color={theme.textMuted} />
                    <Text style={styles.placeFolderTxt}>{g.folder || 'Unfiled'}</Text>
                    <Text style={styles.placeFolderCount}>{g.items.length}</Text>
                  </View>
                )}
                {g.items.map((wp: UserWaypointDocType) => {
                  const open = openPlaceId === wp.id
                  const editing = editPlaceId === wp.id
                  return (
                    <View key={wp.id} style={[styles.placeCard, open && styles.aircraftRowActive]}>
                      <TouchableOpacity
                        style={styles.placeHead}
                        onPress={() => { setOpenPlaceId(open ? null : wp.id); setEditPlaceId(null); setDelPlaceId(null); setInsertPlaceId(null) }}
                      >
                        <Ionicons name="bookmark" size={16} color={theme.accentYellow} />
                        <View style={styles.aircraftInfo}>
                          <Text style={styles.aircraftName}>{wp.name}</Text>
                          <Text style={styles.aircraftMeta}>{wp.lat.toFixed(4)}, {wp.lng.toFixed(4)}</Text>
                        </View>
                        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={theme.textMuted} />
                      </TouchableOpacity>
                      {open && !editing && (
                        <View style={styles.placeActions}>
                          <TouchableOpacity style={styles.placeAction} onPress={() => appendToRoute(wp)}>
                            <Ionicons name="add-circle-outline" size={15} color={theme.accentBlue} />
                            <Text style={styles.placeActionTxt}>Add to route</Text>
                          </TouchableOpacity>
                          {waypoints.length > 0 && (
                            <TouchableOpacity style={styles.placeAction} onPress={() => setInsertPlaceId(insertPlaceId === wp.id ? null : wp.id)}>
                              <Ionicons name="return-down-forward-outline" size={15} color={theme.accentBlue} />
                              <Text style={styles.placeActionTxt}>Insert into route…</Text>
                            </TouchableOpacity>
                          )}
                          {insertPlaceId === wp.id && (
                            <View style={[styles.placeChips, { paddingHorizontal: scaledTheme.space3, paddingBottom: scaledTheme.space2 }]}>
                              <TouchableOpacity style={styles.placeChip} onPress={() => insertIntoRoute(wp, -1)}>
                                <Text style={styles.placeChipTxt}>At start</Text>
                              </TouchableOpacity>
                              {waypoints.map((r, i) => (
                                <TouchableOpacity key={i} style={styles.placeChip} onPress={() => insertIntoRoute(wp, i)}>
                                  <Text style={styles.placeChipTxt}>After {i + 1}{r.name ? ` · ${r.name}` : ''}</Text>
                                </TouchableOpacity>
                              ))}
                            </View>
                          )}
                          <TouchableOpacity style={styles.placeAction} onPress={() => startRouteAt(wp)}>
                            <MaterialCommunityIcons name="map-marker-path" size={15} color={theme.accentBlue} />
                            <Text style={styles.placeActionTxt}>New route from here</Text>
                          </TouchableOpacity>
                          <TouchableOpacity style={styles.placeAction} onPress={() => showPlaceOnMap(wp)}>
                            <Ionicons name="map-outline" size={15} color={theme.accentBlue} />
                            <Text style={styles.placeActionTxt}>Show on map</Text>
                          </TouchableOpacity>
                          <TouchableOpacity style={styles.placeAction} onPress={() => beginEditPlace(wp)}>
                            <Ionicons name="create-outline" size={15} color={theme.accentBlue} />
                            <Text style={styles.placeActionTxt}>Edit</Text>
                          </TouchableOpacity>
                          {delPlaceId === wp.id ? (
                            <TouchableOpacity
                              style={styles.placeAction}
                              onPress={() => { deleteWaypoint(wp.id); setDelPlaceId(null); setOpenPlaceId(null) }}
                            >
                              <Ionicons name="trash" size={15} color={theme.statusDanger} />
                              <Text style={[styles.placeActionTxt, { color: theme.statusDanger }]}>Tap again to delete</Text>
                            </TouchableOpacity>
                          ) : (
                            <TouchableOpacity style={styles.placeAction} onPress={() => setDelPlaceId(wp.id)}>
                              <Ionicons name="trash-outline" size={15} color={theme.statusDanger} />
                              <Text style={[styles.placeActionTxt, { color: theme.statusDanger }]}>Delete</Text>
                            </TouchableOpacity>
                          )}
                        </View>
                      )}
                      {open && editing && (
                        <View style={styles.placeEdit}>
                          <TextInput
                            style={styles.numberInput}
                            value={editName}
                            onChangeText={setEditName}
                            placeholder="Name"
                            placeholderTextColor={theme.textFaint}
                            autoFocus
                          />
                          <TextInput
                            style={styles.numberInput}
                            value={editFolder}
                            onChangeText={setEditFolder}
                            placeholder="Folder (optional)"
                            placeholderTextColor={theme.textFaint}
                          />
                          {placeFolders.length > 0 && (
                            <View style={styles.placeChips}>
                              {placeFolders.map(f => (
                                <TouchableOpacity
                                  key={f}
                                  style={[styles.placeChip, editFolder.trim() === f && styles.placeChipOn]}
                                  onPress={() => setEditFolder(editFolder.trim() === f ? '' : f)}
                                >
                                  <Text style={[styles.placeChipTxt, editFolder.trim() === f && { color: theme.accentBlue }]}>{f}</Text>
                                </TouchableOpacity>
                              ))}
                            </View>
                          )}
                          <View style={styles.saveRowActions}>
                            <TouchableOpacity style={styles.saveConfirm} onPress={() => commitEditPlace(wp)}>
                              <Text style={styles.saveConfirmTxt}>Save</Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => setEditPlaceId(null)}>
                              <Text style={styles.clearBtn}>Cancel</Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                      )}
                    </View>
                  )
                })}
              </View>
            ))
          )}
        </ScrollView>
      )}

      {segment === 'logs' && (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: scaledTheme.space3 }}
          refreshControl={<RefreshControl refreshing={logsRefreshing} onRefresh={handleLogsRefresh} tintColor={theme.accentBlue} />}
        >
          <View style={styles.logFilterRow}>
            <TouchableOpacity style={styles.placeChip} onPress={() => void handleImportLog()} accessibilityLabel="Import flight from GPX">
              <Text style={styles.placeChipTxt}>↑ Import GPX</Text>
            </TouchableOpacity>
          </View>
          {logs.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No flight logs</Text>
              <Text style={styles.emptyBody}>
                Logs are recorded automatically on the map (GPS-detected takeoff/landing) and
                synced to the cloud once completed.
              </Text>
            </View>
          ) : (<>
            <View style={styles.logFilterRow}>
              {LOG_PERIODS.map(p => (
                <TouchableOpacity key={p} style={[styles.placeChip, logPeriod === p && styles.placeChipOn]} onPress={() => setLogPeriod(p)}>
                  <Text style={[styles.placeChipTxt, logPeriod === p && { color: theme.accentBlue }]}>{LOG_PERIOD_LABEL[p]}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {logRegistrations.length > 1 && (
              <View style={styles.logFilterRow}>
                {['', ...logRegistrations].map(r => (
                  <TouchableOpacity key={r || 'all'} style={[styles.placeChip, logReg === r && styles.placeChipOn]} onPress={() => setLogReg(r)}>
                    <Text style={[styles.placeChipTxt, logReg === r && { color: theme.accentBlue }]}>{r || 'All aircraft'}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <Text style={styles.aircraftMeta}>
              {logSummaryTotals.logs} flight{logSummaryTotals.logs === 1 ? '' : 's'} · {formatLogDuration(logSummaryTotals.airborneMs)} · {logSummaryTotals.landings} landing{logSummaryTotals.landings === 1 ? '' : 's'} · {Math.round(logSummaryTotals.distanceNm)} NM
            </Text>
            {shownLogs.length === 0 && <Text style={styles.aircraftMeta}>No flights match this filter.</Text>}
            {shownLogs.map(log => {
              const isActive = selectedLog?.id === log.id
              const isCompleted = log.endedAt > 0
              return (
                <View key={log.id} style={[styles.aircraftRow, isActive && styles.aircraftRowActive]}>
                  <View style={styles.aircraftInfo}>
                    <Text style={styles.aircraftName}>
                      {log.departureIcao || '?'} → {log.arrivalIcao || (isCompleted ? '?' : '— in progress')}
                    </Text>
                    <Text style={styles.aircraftMeta}>
                      {new Date(log.startedAt).toLocaleString()} · {log.distanceNm.toFixed(0)} NM · {log.registration}
                      {isCompleted ? ` · ${logInfo(log).summary}` : ''}
                    </Text>
                  </View>
                  <View style={styles.aircraftActions}>
                    {!isCompleted ? (
                      <Text style={styles.aircraftMeta}>Recording…</Text>
                    ) : logDeleteId === log.id ? (
                      <>
                        <TouchableOpacity style={styles.removeBtn} onPress={() => { void deleteLog(log.id); if (isActive) clearView(); setLogDeleteId(null) }}>
                          <Ionicons name="checkmark" size={16} color={theme.statusDanger} />
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.removeBtn} onPress={() => setLogDeleteId(null)}>
                          <Ionicons name="close" size={16} color={theme.textMuted} />
                        </TouchableOpacity>
                      </>
                    ) : (
                      <>
                        <TouchableOpacity style={styles.removeBtn} onPress={() => handleViewLog(log)}>
                          <Ionicons name={isActive ? 'eye-off-outline' : 'eye-outline'} size={16} color={isActive ? theme.accentBlue : theme.textMuted} />
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.removeBtn} onPress={() => void handleExportLog(log)} accessibilityLabel="Export flight as GPX">
                          <Ionicons name="share-outline" size={16} color={theme.textMuted} />
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.removeBtn} onPress={() => setLogDeleteId(log.id)}>
                          <Ionicons name="trash-outline" size={14} color={theme.statusDanger} />
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                </View>
              )
            })}
          </>)}
        </ScrollView>
      )}
    </View>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────
function Row({ label, value, accent, warn, bold }: {
  label: string; value: string; accent?: boolean; warn?: boolean; bold?: boolean
}) {
  const rowStyles = useThemedStyles(makeRowStyles)
  return (
    <View style={rowStyles.row}>
      <Text style={rowStyles.label}>{label}</Text>
      <Text style={[
        rowStyles.value,
        accent && rowStyles.valueAccent,
        warn   && rowStyles.valueWarn,
        bold   && rowStyles.valueBold,
      ]}>{value}</Text>
    </View>
  )
}

function makeRowStyles(theme: ScaledTheme) {
 return {
  row:         { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  label:       { color: theme.textMuted, fontSize: theme.textSm },
  value:       { color: theme.textPrimary, fontSize: theme.textSm, fontWeight: '500' },
  valueAccent: { color: theme.accentBlue },
  valueWarn:   { color: theme.statusDanger },
  valueBold:   { fontWeight: '700' },
} as const
}

// ── Styles ──────────────────────────────────────────────────────────────────
function makeStyles(theme: ScaledTheme) {
 return {
  container:   { flex: 1, backgroundColor: theme.surfaceBase },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: theme.space4, paddingVertical: theme.space3,
    borderBottomWidth: 1, borderBottomColor: theme.borderSubtle,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: theme.space3 },
  headerTitle: { color: theme.textPrimary, fontSize: theme.textLg, fontWeight: '600' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space3 },
  headerBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    height: theme.scale(26), paddingHorizontal: theme.space2,
    borderRadius: theme.radiusSm, borderWidth: 1, borderColor: theme.accentBlue,
  },
  headerBtnInactive: { borderColor: 'rgba(248, 113, 113, 0.85)', backgroundColor: 'rgba(248, 113, 113, 0.85)' },
  moreBtn: {
    width: theme.scale(26), height: theme.scale(26),
    alignItems: 'center', justifyContent: 'center',
    borderRadius: theme.radiusSm, borderWidth: 1, borderColor: theme.accentBlue,
  },
  headerBtnTxt: { color: theme.accentBlue, fontSize: theme.textXs, fontWeight: '700' },
  headerBtnTxtInactive: { color: '#ffffff' },
  clearBtn:    { color: theme.accentRed, fontSize: theme.textSm },

  // Overflow ("...") menu -- Open Route Library / Undo / Export / Import
  moreMenuBackdrop: { flex: 1 },
  moreMenu: {
    position: 'absolute', right: theme.space4, minWidth: theme.scale(180),
    backgroundColor: theme.surfaceSheet, borderRadius: theme.radiusMd,
    borderWidth: 1, borderColor: theme.borderDefault, paddingVertical: theme.space1,
  },
  moreMenuItem: {
    flexDirection: 'row', alignItems: 'center', gap: theme.space2,
    paddingHorizontal: theme.space3, paddingVertical: theme.space2,
  },
  moreMenuItemTxt: { color: theme.textPrimary, fontSize: theme.textSm },

  inputsCard: {
    margin: theme.space3, padding: theme.space3,
    backgroundColor: theme.surfacePanel, borderRadius: theme.radiusMd,
    borderWidth: 1, borderColor: theme.borderSubtle, gap: theme.space2,
  },
  inputRow:    { flexDirection: 'row', alignItems: 'center', gap: theme.space2 },
  inputLabel:  { color: theme.textMuted, fontSize: theme.textXs, width: theme.scale(96) },
  inputHint:   { color: theme.textFaint, fontSize: theme.textXs, fontStyle: 'italic' },
  windInputs:  { flexDirection: 'row', alignItems: 'center', gap: 4 },
  inputSep:    { color: theme.textFaint, fontSize: theme.textSm },
  numberInput: {
    backgroundColor: theme.surfaceOverlay, borderWidth: 1, borderColor: theme.borderDefault,
    borderRadius: theme.radiusSm, paddingHorizontal: theme.space2, paddingVertical: 4,
    color: theme.textPrimary, fontSize: theme.textSm, minWidth: 52, textAlign: 'center',
  },
  profileScroll: { flexGrow: 0 },
  profileChip: {
    paddingHorizontal: theme.space2, paddingVertical: 3, marginRight: 6,
    borderRadius: theme.radiusSm, borderWidth: 1, borderColor: theme.borderDefault,
    backgroundColor: theme.surfaceOverlay,
  },
  profileChipActive: { borderColor: theme.accentBlue, backgroundColor: 'rgba(59,130,246,0.12)' },
  profileChipTxt:    { color: theme.textMuted, fontSize: theme.textXs },

  segmentRow: {
    flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: theme.borderSubtle,
  },
  segmentBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: theme.space3, borderBottomWidth: 2, borderBottomColor: 'transparent',
  },
  segmentBtnActive: { borderBottomColor: theme.accentBlue },
  segmentTxt:       { color: theme.textMuted, fontSize: theme.textSm, fontWeight: '600' },
  segmentTxtActive: { color: theme.accentBlue },

  aircraftRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: theme.space3, marginBottom: theme.space2,
    backgroundColor: theme.surfacePanel, borderRadius: theme.radiusMd,
    borderWidth: 1, borderColor: theme.borderSubtle,
  },
  aircraftRowActive: { borderColor: theme.accentBlue },
  aircraftInfo: { flex: 1 },
  aircraftActions: { flexDirection: 'row', alignItems: 'center' },
  aircraftName: { color: theme.textPrimary, fontSize: theme.textSm, fontWeight: '600' },
  aircraftMeta: { color: theme.textFaint, fontSize: theme.textXs, marginTop: 2 },
  categoryBadge: { color: theme.textFaint, fontSize: 9, fontWeight: '700' },

  placeFolderHdr: { flexDirection: 'row', alignItems: 'center', gap: theme.space1, paddingVertical: theme.space1, marginTop: theme.space1 },
  placeFolderTxt: { color: theme.textMuted, fontSize: theme.textXs, fontWeight: '700', textTransform: 'uppercase', flex: 1 },
  placeFolderCount: { color: theme.textFaint, fontSize: theme.textXs },
  placeCard: {
    marginBottom: theme.space2, backgroundColor: theme.surfacePanel, borderRadius: theme.radiusMd,
    borderWidth: 1, borderColor: theme.borderSubtle, overflow: 'hidden',
  },
  placeHead: { flexDirection: 'row', alignItems: 'center', gap: theme.space2, padding: theme.space3 },
  placeActions: { borderTopWidth: 1, borderTopColor: theme.borderSubtle, paddingVertical: theme.space1 },
  placeAction: { flexDirection: 'row', alignItems: 'center', gap: theme.space2, paddingHorizontal: theme.space3, paddingVertical: theme.space2 },
  placeActionTxt: { color: theme.textPrimary, fontSize: theme.textSm },
  placeEdit: { borderTopWidth: 1, borderTopColor: theme.borderSubtle, padding: theme.space3, gap: theme.space2 },
  placeChips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space1 },
  placeChip: { paddingHorizontal: theme.space2, paddingVertical: theme.space1, borderRadius: theme.radiusSm, borderWidth: 1, borderColor: theme.borderDefault },
  placeChipOn: { borderColor: theme.accentBlue },
  logFilterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space1, marginBottom: theme.space2 },
  placeChipTxt: { color: theme.textMuted, fontSize: theme.textXs },

  saveSection: {
    padding: theme.space3, marginBottom: theme.space2,
    backgroundColor: theme.surfacePanel, borderRadius: theme.radiusMd,
    borderWidth: 1, borderColor: theme.borderSubtle,
  },
  saveBtn:    { flexDirection: 'row', alignItems: 'center', gap: theme.space1 },
  saveBtnTxt: { color: theme.accentBlue, fontSize: theme.textSm },
  saveRowActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space3, marginTop: theme.space1 },
  saveConfirm: {
    backgroundColor: theme.accentBlue, borderRadius: theme.radiusSm,
    paddingHorizontal: theme.space3, paddingVertical: 5,
  },
  saveConfirmTxt: { color: '#fff', fontSize: theme.textSm, fontWeight: '600' },
  profileChipTxtActive: { color: theme.accentBlue, fontWeight: '600' },

  empty: {
    padding: theme.space5, alignItems: 'center', gap: theme.space2,
  },
  emptyTitle: { color: theme.textSecondary, fontSize: theme.textMd, fontWeight: '500' },
  emptyBody:  { color: theme.textMuted, fontSize: theme.textSm, textAlign: 'center', lineHeight: 18 },

  wpRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: theme.space3, paddingVertical: theme.space2, gap: theme.space2,
  },
  reorderCol:  { justifyContent: 'center', gap: 0 },
  badge: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: theme.surfaceOverlay,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 1, borderColor: theme.accentMagenta,
  },
  badgeText:   { color: theme.accentMagenta, fontSize: theme.textXs, fontWeight: '700' },
  wpInfo:      { flex: 1 },
  wpName:      { color: theme.textPrimary, fontSize: theme.textSm, fontWeight: '500' },
  wpTafWarn:   { color: '#f59e0b' },
  wpEta:       { color: theme.accentBlue, fontSize: theme.textXs, marginTop: 1 },
  wpNote:      { color: theme.textMuted, fontSize: theme.textXs, marginTop: 1, fontStyle: 'italic' },
  // Bordered chip "button" affordance so the leg-properties tap target reads
  // as an action, not inert stats text - mirrors web's RoutePlan.module.css
  // .arrow chip fix (same discoverability bug, ported here for parity).
  legCol: {
    flexDirection: 'row', alignItems: 'center', gap: theme.space2,
    marginLeft: 56, marginRight: theme.space3, marginBottom: theme.space2,
    paddingHorizontal: theme.space2, paddingVertical: theme.space2,
    borderRadius: theme.radiusSm, borderWidth: 1, borderColor: theme.borderDefault,
    backgroundColor: theme.surfaceOverlay,
  },
  legColSet: {
    borderColor: theme.accentBlue, backgroundColor: theme.surfaceHover,
  },
  legStats:    { flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: theme.space3, rowGap: 2 },
  legDist:     { color: theme.textPrimary, fontSize: theme.textSm, fontWeight: '600' },
  legHdg:      { color: theme.accentBlue, fontSize: theme.textSm },
  legHdgSet:   { color: theme.accentYellow, fontWeight: '700' },
  legEte:      { color: theme.textSecondary, fontSize: theme.textSm },
  legWca:      { color: theme.textMuted, fontSize: theme.textXs },
  legPropsPanel: {
    marginHorizontal: theme.space3, marginBottom: theme.space2, padding: theme.space3,
    backgroundColor: theme.surfacePanel, borderRadius: theme.radiusMd,
    borderWidth: 1, borderColor: theme.accentBlue, gap: theme.space2,
  },
  altSetTxt:   { color: theme.textPrimary, fontSize: theme.textSm, fontWeight: '600' },
  removeBtn:   { padding: theme.space2 },
  removeBtnText: { color: theme.textFaint, fontSize: theme.textSm },
  separator:   { height: 1, backgroundColor: theme.borderSubtle, marginHorizontal: theme.space3 },

  totalsCard: {
    margin: theme.space3, padding: theme.space3,
    backgroundColor: theme.surfacePanel, borderRadius: theme.radiusMd,
    borderWidth: 1, borderColor: theme.borderSubtle,
  },
  fuelCard: {
    margin: theme.space3, marginTop: 0, padding: theme.space3,
    backgroundColor: theme.surfacePanel, borderRadius: theme.radiusMd,
    borderWidth: 1, borderColor: theme.borderSubtle,
  },
  cardTitle: {
    color: theme.textFaint, fontSize: theme.textXs, fontWeight: '700',
    letterSpacing: 0.8, marginBottom: theme.space2,
  },
  fuelDivider: { height: 1, backgroundColor: theme.borderSubtle, marginVertical: theme.space1 },
} as const
}
