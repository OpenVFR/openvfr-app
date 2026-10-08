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
  ScrollView, TextInput, Share, RefreshControl,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useNavigation } from '@react-navigation/native'
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons'
import * as Crypto from 'expo-crypto'

import { useRouteContext } from '../context/RouteContext'
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
import { useFlightLogViewContext } from '../context/FlightLogViewContext'
import { useTakeoffTime, useAlternate, useGlobalWind } from '../hooks/usePlanningSettings'
import { getAerodromeLookup } from '../utils/aerodromeLookup'
import type { UserWaypointDocType } from '../types/db'
import type { LegOverride } from '../types/db'
import { distanceNm, magneticBearingDeg, bearingDeg } from '../utils/routeCalc'
import { nmToDisplay, distLabel, ktsToDisplay, displayToKts, speedLabel } from '../utils/units'
import { computeFuelPlan } from '../utils/fuelCalc'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'

type Segment = 'route' | 'aircraft' | 'waypoints' | 'logs'
const SEGMENTS: { key: Segment; label: string; icon: React.ComponentProps<typeof Ionicons>['name'] }[] = [
  { key: 'route',     label: 'Route',     icon: 'navigate-outline' },
  { key: 'aircraft',  label: 'Aircraft',  icon: 'airplane-outline' },
  { key: 'waypoints', label: 'Waypoints', icon: 'pin-outline' },
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
import { routeToGpx, gpxToRoute, waypointsToGpx, gpxToWaypoints } from '@open-vfr/shared/gpx'
import { iasToTas } from '@open-vfr/shared/airspeed'
import * as FileSystem from 'expo-file-system'
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
export function PlanScreen() {
  const scaledTheme = useScaledTheme()
  const styles = useThemedStyles(makeStyles)
  const insets = useSafeAreaInsets()
  const { waypoints, legOverrides, removeWaypoint, clearRoute, setWaypoints, moveWaypoint, reverseRoute, setLegOverride, activeRouteId, setActiveRouteId, routeVisible, setRouteVisible } = useRouteContext()
  const { settings, update } = useSettingsContext()
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

  // Flight logs — auto-recorded on the Map tab (GPS takeoff/landing detection),
  // synced to cloud (upload-only + cross-device pull) when authenticated.
  const { logs, pull: pullLogs, deleteLog } = useFlightLogSync(authenticated)
  const { selectedLog, viewLog, clearView } = useFlightLogViewContext()
  const navigation = useNavigation()
  const [logDeleteId, setLogDeleteId] = useState<string | null>(null)
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
  function openLegProps(i: number) {
    const o = legOverrides[i] ?? {}
    setOvrAlt(o.altFt != null ? String(o.altFt) : '')
    setOvrSpd(o.speedKts != null ? String(Math.round(ktsToDisplay(o.speedKts, units.speed))) : '')
    setOvrWDir(o.windDir != null ? String(o.windDir) : '')
    setOvrWSpd(o.windSpd != null ? String(Math.round(ktsToDisplay(o.windSpd, units.speed))) : '')
    setActiveLeg(i === activeLeg ? null : i)
  }
  function saveLegProps(i: number) {
    const next: LegOverride = {}
    const alt = parseFloat(ovrAlt); if (!isNaN(alt)) next.altFt = alt
    const spd = parseFloat(ovrSpd); if (!isNaN(spd)) next.speedKts = displayToKts(spd, units.speed)
    const wd  = parseFloat(ovrWDir); if (!isNaN(wd)) next.windDir = ((Math.round(wd) % 360) + 360) % 360
    const ws  = parseFloat(ovrWSpd); if (!isNaN(ws)) next.windSpd = displayToKts(ws, units.speed)
    setLegOverride(i, next)
    setActiveLeg(null)
  }

  // Cruise IAS — from profile or fallback to 90 kts. Converted to TAS at each leg's altitude below.
  const cruiseIas = profile?.cruiseIas ?? 90
  const cruiseAltFt = profile?.cruiseAltFt || 3500

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
      const effDir  = ovr?.windDir  ?? wind?.dirDeg
      const effSpd  = ovr?.windSpd  ?? wind?.speedKts
      const hasWind = effDir != null && effSpd != null && effSpd > 0
      const wca     = hasWind ? wcaDeg(trueHdg, effDir!, effSpd!, tas) : 0
      const gs      = hasWind ? gsKts(trueHdg, effDir!, effSpd!, tas) : tas
      const eteMins = gs > 0 ? (distNm / gs) * 60 : null
      return { from, to, distNm, magHdg, wca, gs, eteMins, index: i, altFt: ovr?.altFt }
    })
  }, [waypoints, wind, cruiseIas, cruiseAltFt, legOverrides])

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
    return computeFuelPlan(waypoints, legOverrides, profile)
  }, [profile, waypoints, legOverrides])

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

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Flight Plan</Text>
        {segment === 'route' && (
          <View style={styles.headerActions}>
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
        )}
      </View>

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
            <Text style={styles.emptyTitle}>No waypoints</Text>
            <Text style={styles.emptyBody}>
              Long-press the map or tap aerodromes, navaids, and waypoints on the Map tab to build a route.
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
                  <Text style={styles.wpName}>{wp.name ?? `${wp.lat.toFixed(3)}°N`}</Text>
                  {eta && <Text style={styles.wpEta}>{eta}</Text>}
                  {wp.note ? <Text style={styles.wpNote} numberOfLines={1}>📌 {wp.note}</Text> : null}
                </View>
                {leg && (
                  <TouchableOpacity
                    style={[styles.legCol, hasOverride && styles.legColSet]}
                    onPress={() => openLegProps(index)}
                  >
                    <View style={styles.legColHeader}>
                      <Text style={styles.legDist}>
                        {nmToDisplay(leg.distNm, units.distance).toFixed(1)} {distLabel(units.distance)}
                      </Text>
                      <Ionicons name="create-outline" size={11} color={hasOverride ? theme.accentBlue : theme.textFaint} />
                    </View>
                    <View style={styles.legHdgEteRow}>
                      <Text style={[styles.legHdg, hasOverride && styles.legHdgSet]}>{Math.round(leg.magHdg).toString().padStart(3, '0')}°M</Text>
                      {leg.eteMins != null && (
                        <Text style={styles.legEte}>{fmtTime(leg.eteMins)}</Text>
                      )}
                    </View>
                    {leg.altFt != null && (
                      <Text style={styles.legWca}>{Math.round(leg.altFt)} ft</Text>
                    )}
                    {Math.abs(leg.wca) >= 1 && (
                      <Text style={styles.legWca}>WCA {leg.wca > 0 ? '+' : ''}{Math.round(leg.wca)}°</Text>
                    )}
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={styles.removeBtn} onPress={() => handleRemove(index)}>
                  <Text style={styles.removeBtnText}>✕</Text>
                </TouchableOpacity>
              </View>
              {activeLeg === index && leg && (
                <View style={styles.legPropsPanel}>
                  <Text style={styles.cardTitle}>Leg {index + 1}: override</Text>
                  <View style={styles.windInputs}>
                    <TextInput style={styles.numberInput} value={ovrAlt} onChangeText={setOvrAlt} placeholder="Alt ft" placeholderTextColor={theme.textFaint} keyboardType="numeric" />
                    <TextInput style={styles.numberInput} value={ovrSpd} onChangeText={setOvrSpd} placeholder={`IAS ${speedLabel(units.speed)}`} placeholderTextColor={theme.textFaint} keyboardType="numeric" />
                  </View>
                  <View style={styles.windInputs}>
                    <TextInput style={styles.numberInput} value={ovrWDir} onChangeText={setOvrWDir} placeholder="Wind Dir°" placeholderTextColor={theme.textFaint} keyboardType="numeric" />
                    <TextInput style={styles.numberInput} value={ovrWSpd} onChangeText={setOvrWSpd} placeholder={`Wind ${speedLabel(units.speed)}`} placeholderTextColor={theme.textFaint} keyboardType="numeric" />
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
          contentContainerStyle={{ padding: scaledTheme.space3 }}
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
                  Tip: long-press anywhere on the Map tab to save that point as a waypoint directly.
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
                  Tip: tap a point on the Map tab to read its coordinates, or long-press to add it directly to the route.
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

          {userWaypoints.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No saved waypoints</Text>
              <Text style={styles.emptyBody}>Save custom waypoints to reuse across routes and devices.</Text>
            </View>
          ) : (
            [...userWaypoints].sort((a, b) => b.updatedAt - a.updatedAt).map((wp: UserWaypointDocType) => (
              <View key={wp.id} style={styles.aircraftRow}>
                <View style={styles.aircraftInfo}>
                  <Text style={styles.aircraftName}>{wp.name}</Text>
                  <Text style={styles.aircraftMeta}>
                    {wp.lat.toFixed(4)}, {wp.lng.toFixed(4)}{wp.folder ? ` · ${wp.folder}` : ''}
                  </Text>
                </View>
                <TouchableOpacity style={styles.removeBtn} onPress={() => deleteWaypoint(wp.id)}>
                  <Ionicons name="trash-outline" size={14} color={theme.statusDanger} />
                </TouchableOpacity>
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
          {logs.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No flight logs</Text>
              <Text style={styles.emptyBody}>
                Logs are recorded automatically on the Map tab (GPS-detected takeoff/landing) and
                synced to the cloud once completed.
              </Text>
            </View>
          ) : (
            [...logs].sort((a, b) => b.startedAt - a.startedAt).map(log => {
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
                        <TouchableOpacity style={styles.removeBtn} onPress={() => setLogDeleteId(log.id)}>
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
  wpEta:       { color: theme.accentBlue, fontSize: theme.textXs, marginTop: 1 },
  wpNote:      { color: theme.textMuted, fontSize: theme.textXs, marginTop: 1, fontStyle: 'italic' },
  // Bordered chip "button" affordance so the leg-properties tap target reads
  // as an action, not inert stats text - mirrors web's RoutePlan.module.css
  // .arrow chip fix (same discoverability bug, ported here for parity).
  legCol: {
    alignItems: 'flex-end', gap: 1, minWidth: 74,
    paddingHorizontal: theme.space2, paddingVertical: theme.space1,
    borderRadius: theme.radiusSm, borderWidth: 1, borderColor: theme.borderDefault,
    backgroundColor: theme.surfaceOverlay,
  },
  legColSet: {
    borderColor: theme.accentBlue, backgroundColor: theme.surfaceHover,
  },
  legColHeader: { flexDirection: 'row', alignItems: 'center', gap: theme.space1 },
  legDist:     { color: theme.textSecondary, fontSize: theme.textSm, fontWeight: '500' },
  legHdgEteRow: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space1 },
  legHdg:      { color: theme.accentBlue, fontSize: theme.textXs },
  legHdgSet:   { color: theme.accentYellow, fontWeight: '700' },
  legEte:      { color: theme.textMuted, fontSize: theme.textXs },
  legWca:      { color: theme.accentYellow, fontSize: 9 },
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
