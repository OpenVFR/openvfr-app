/**
 * MapScreen — full-screen map with aviation overlays and GPS instruments.
 *
 * Tap  aerodrome  → AerodromePopup
 * Tap  airspace   → AirspacePopup
 * Long-press      → add waypoint to route
 * Layers button   → MapDisplaySheet (ceiling + per-class airspace + points)
 * Go Flying       → GPS tracking + screen keep-awake
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react'
import { View, TouchableOpacity, Text, Alert, TextInput, ScrollView, useWindowDimensions, Linking } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as KeepAwake from 'expo-keep-awake'
import type { Feature, FeatureCollection, Point } from 'geojson'

import { AviationMap }       from '../components/AviationMap'
import { MapDisplaySheet, LAYER_DEFAULTS } from '../components/MapDisplaySheet'
import { VicinityBriefSheet } from '../components/VicinityBriefSheet'
import { FindDestinationSheet } from '../components/FindDestinationSheet'
import { useWeatherAlongRoute } from '../hooks/useWeatherAlongRoute'
import { useWindAlongRoute } from '../hooks/useWindAlongRoute'
import type { LayerState }   from '../components/MapDisplaySheet'

import { AerodromePopup }    from '../components/AerodromePopup'
import type { AerodromeFeatureProps } from '../components/AerodromePopup'
import type { RunwayWindEnd } from '@open-vfr/shared/runwayWind'
import { AirspacePopup }     from '../components/AirspacePopup'
import type { AirspaceFeatureProps, RegionalNotamHit } from '../components/AirspacePopup'
import { FeaturePopup }      from '../components/FeaturePopup'
import type { FeatureInfo }  from '../components/FeaturePopup'
import { useGps }            from '../hooks/useGps'
import { useRouteContext } from '../context/RouteContext'
import { SnapPicker, type SnapCandidate } from '../components/SnapPicker'
import { useTraffic }        from '../hooks/useTraffic'
import { useRegionalNotams } from '../hooks/useRegionalNotams'
import { useNotamPrefs } from '../hooks/useNotamPrefs'
import { isIfrOnly } from '@open-vfr/shared/notamRelevance'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import { makeCirclePolygon } from '@open-vfr/shared/geoCircle'
import { NotificationCenter } from '../components/NotificationCenter'
import { queryAirspaceAtPoint } from '@open-vfr/shared/airspaceQuery'
import { getTileUrls } from '../config'
import { parseMapLink, hasMapLink } from '@open-vfr/shared/deepLink'
import { useDataFreshness } from '../hooks/useDataFreshness'

/** In flight: auto-return to follow this long after the last user pan. */
const FOLLOW_RETURN_MS = 15_000

/** GeoJSON aerodrome feature properties -> AerodromePopup props. Nested
 *  arrays arrive JSON-stringified from MapLibre feature queries but as real
 *  arrays from a raw GeoJSON fetch -- `parse` accepts both. Shared by the
 *  map-tap path and the shareable-link path. */
function aerodromePropsFromFeature(p: Record<string, unknown>, coords: [number, number] | null): AerodromeFeatureProps {
  const parse = <T,>(v: unknown): T => typeof v === 'string' ? JSON.parse(v) : v as T
  return {
    icao:         p.icao as string,
    name:         p.name as string ?? '',
    type:         p.type as string | undefined,
    elevation_ft: p.elevation_ft as number | undefined,
    frequencies:  p.frequencies ? parse(p.frequencies) : [],
    fuel:         p.fuel        ? parse(p.fuel)        : [],
    ppr:          p.ppr as boolean | undefined,
    ppr_remarks:  p.ppr_remarks ? parse(p.ppr_remarks) : [],
    runways:      p.runways     ? parse(p.runways)     : [],
    towered:      p.towered as boolean | undefined,
    hours_of_operation:   p.hours_of_operation   ? parse(p.hours_of_operation)   : [],
    handling_facilities:  p.handling_facilities  ? parse(p.handling_facilities)  : [],
    passenger_facilities: p.passenger_facilities ? parse(p.passenger_facilities) : [],
    lng: coords ? coords[0] : undefined,
    lat: coords ? coords[1] : undefined,
  }
}
import { settings as settingsDb } from '../db'
import { usePositionAlerts } from '../hooks/usePositionAlerts'
import { useSimContext }     from '../context/SimContext'
import { useNearbyFrequencies } from '../hooks/useNearbyFrequencies'
import { useLivePlog } from '../hooks/useLivePlog'
import { LivePlogPanel } from '../components/LivePlogPanel'
import { useFlightLog } from '../hooks/useFlightLog'
import { useFlightLogSync } from '../hooks/useFlightLogSync'
import { useAuthContext } from '../context/AuthContext'
import { useUserWaypointContext } from '../context/UserWaypointContext'
import { useHomeAirfield }      from '../hooks/useHomeAirfield'
import { useSettingsContext } from '../context/SettingsContext'
import { RouteEditBanner } from '../components/RouteEditBanner'
import { VerticalProfile, DEFAULT_CHART_H, COLLAPSE_THRESHOLD } from '../components/VerticalProfile'
import { RulerHeaderStart, RulerHeaderEnd, RouteHeaderStart } from '../components/RulerHeaderStats'
import { PastTrackChart } from '../components/PastTrackChart'
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons'
import * as Location from 'expo-location'
import * as Crypto from 'expo-crypto'
import { GaugesBar }         from '../components/GaugesBar'
import { distanceAlongRouteNm, coordinateAlongRouteNm, routeCrossTrackNm } from '@open-vfr/shared/virtualRadarCalc'
import { aircraft as aircraftDb, flightLogs as flightLogsDb } from '../db'
import type { AircraftProfileDocType } from '../types/db'
import { useTerrainElevation } from '../hooks/useTerrainElevation'
import { useAltitudeSource } from '../hooks/useAltitudeSource'
import { useVarioContext } from '../context/VarioContext'
import { useFlightLogViewContext } from '../context/FlightLogViewContext'
import type { TrackPoint } from '../types/db'
import { useWind }           from '../hooks/useWind'
import { useSimFlight }      from '../hooks/useSimFlight'
import { FlightModeSheet, type FlightModeStatus } from '../components/FlightModeSheet'
import { SimControlPanel }   from '../components/SimControlPanel'
import { advancePosition, distanceNm, bearingDeg } from '../utils/routeCalc'
import { createValueStore } from '../utils/valueStore'
import type { RouteWaypoint } from '../types/db'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import { isLowMemoryDevice } from '../utils/deviceMemory'
import { NativeSheet } from '../components/NativeSheet'
import { BaroPromptModal } from '../components/BaroPromptModal'
import { useTabBarCollapsed } from '../context/TabBarContext'

function isAerodrome(p: Record<string, unknown>) {
  // `icao` alone isn't a safe discriminator -- a real minority of aerodromes
  // in the dataset (small private strips with no genuine ICAO code, e.g.
  // "ESTAGA", "ESBJAL") carry a longer-than-4-char pseudo-ICAO (see
  // fetchWx.ts's fetchWxNearest doc comment for the same data quirk on the
  // weather side). A former `p.icao.length === 4` check silently treated
  // every one of those as "not an aerodrome" -- tapping one fell through to
  // the generic point-feature branch below and added it to the route
  // instead of opening AerodromePopup, with no visible error. `runways` is
  // a property only the aerodromes source ever carries (navaids/waypoints
  // features have neither `icao` nor `runways` at all -- confirmed against
  // the actual tile schemas), so it's a safe discriminator regardless of
  // ICAO length.
  return typeof p.icao === 'string' && Array.isArray(p.runways)
}

function isAirspace(p: Record<string, unknown>) {
  return typeof p.class === 'string' && p.lower_ft !== undefined
}

// Same ring extraction as web's MapView.tsx notamGeometryRing -- circle-fill
// features are a synthesized Polygon already matching makeCirclePolygon's
// output, real-geometry polygon-fill features are the NOTAM's true shape;
// both need no separate re-derivation. Point-only markers (no area extent)
// return undefined so PolygonThumb falls back to its plain-square placeholder.
function notamGeometryRing(geom: Feature['geometry']): number[][] | undefined {
  if (geom.type === 'Polygon') return geom.coordinates[0]
  if (geom.type === 'MultiPolygon') return geom.coordinates[0]?.[0]
  return undefined
}

// Same ring extraction as web's MapView.tsx notamItemRing, but from a
// NotamItem's OWN stored geometry (real polygon, or synthesized from
// lat/lon/radiusNm) rather than a tapped map feature's queried geometry.
// Needed because MapLibre Native, like web, tiles GeoJSON sources internally
// even for a single feature spanning multiple internal tiles at the current
// zoom -- a tap-query on notamGeometryRing(feature.geometry) above returns
// that tile-local, boundary-clipped geometry (a partial wedge/arc instead of
// the whole circle/polygon), not the full source feature.
function notamItemRing(n: NotamItem): number[][] | undefined {
  if (n.polygon) {
    return n.polygon.type === 'Polygon' ? n.polygon.coordinates[0] : n.polygon.coordinates[0]?.[0]
  }
  if (n.lat !== null && n.lon !== null && n.radiusNm !== null && n.radiusNm > 0) {
    return makeCirclePolygon(n.lat, n.lon, n.radiusNm).geometry.coordinates[0]
  }
  return undefined
}

/** Interpolate a lat/lng at a given cumulative distance (NM) along a raw GPS
 *  track (not a RouteWaypoint route — that's what coordinateAlongRouteNm is
 *  for). Mirrors web's local coordAlongTrack in MapView.tsx. Used to place
 *  the profile-cursor map marker while scrubbing a viewed flight log. */
function coordAlongTrack(track: TrackPoint[], targetNm: number): { lng: number; lat: number } {
  const NM_PER_DEG_LAT = 60.0
  let cumDist = 0
  for (let i = 1; i < track.length; i++) {
    const dLat = (track[i].lat - track[i - 1].lat) * NM_PER_DEG_LAT
    const dLng = (track[i].lng - track[i - 1].lng) * NM_PER_DEG_LAT *
      Math.cos((track[i - 1].lat + track[i].lat) * 0.5 * Math.PI / 180)
    const segDist = Math.sqrt(dLat * dLat + dLng * dLng)
    if (cumDist + segDist >= targetNm) {
      const t = segDist > 0 ? (targetNm - cumDist) / segDist : 0
      return {
        lat: track[i - 1].lat + t * (track[i].lat - track[i - 1].lat),
        lng: track[i - 1].lng + t * (track[i].lng - track[i - 1].lng),
      }
    }
    cumDist += segDist
  }
  return { lat: track[track.length - 1].lat, lng: track[track.length - 1].lng }
}

// Stable empty input for the ruler's useWeatherAlongRoute instance while the
// ruler profile is hidden -- a fresh [] per render would re-run its effect.
const NO_WAYPOINTS: RouteWaypoint[] = []

export function MapScreen() {
  const scaledTheme = useScaledTheme()
  const styles = useThemedStyles(makeStyles)
  const insets                                = useSafeAreaInsets()
  const { width: windowWidth, height: windowHeight } = useWindowDimensions()
  const { position, status, start, stop }     = useGps()
  const { simStatus, simPosition, startUdp, startWs, stopSim } = useSimContext()
  // Internal touch-controlled flight simulation (useSimFlight) — distinct
  // from useSimContext above, which is an EXTERNAL simulator connection
  // (X-Plane/MSFS via UDP or WebSocket, configured in Settings). Precedence:
  // external sim > internal touch sim > real GPS.
  const simFlight = useSimFlight()
  const activePosition = simPosition ?? simFlight.position ?? position
  const { waypoints, legOverrides, addWaypoint, insertWaypoint, updateWaypoint, removeWaypoint,
           routeVisible, activeRouteId, routeFitNonce,
           editSessionActive, setEditSessionArmed, applyEditSession, cancelEditSession,
           undo: undoRoute, redo: redoRoute, canUndo, canRedo } = useRouteContext()
  const { settings, update }                  = useSettingsContext()
  const { state: authState } = useAuthContext()
  const authenticated = authState.status === 'authenticated'

  const [aircraftProfile, setAircraftProfile] = useState<AircraftProfileDocType | undefined>(undefined)
  React.useEffect(() => {
    if (!settings.selectedAircraftId) { setAircraftProfile(undefined); return }
    aircraftDb.get(settings.selectedAircraftId).then(setAircraftProfile)
  }, [settings.selectedAircraftId])

  // Map Ruler — mirrors web's MapView.tsx ruler tool. Each tap while active
  // sets/rolls the two measurement points (A, then B, then each further tap
  // replaces A with the old B and sets a new B) — handled in AviationMap's
  // handleMapPress, this screen just owns the resulting state. Declared
  // before showRulerProfile below, which reads it.
  const [rulerMode, setRulerMode] = useState(false)
  const [rulerPoints, setRulerPoints] = useState<RouteWaypoint[]>([])

  const [flying, setFlying]           = useState(false)
  const [followGps, setFollowGps]     = useState(false)
  const [mapOrientation, setMapOrientation] = useState<'north' | 'track'>('north')
  // Map-layer toggle visibility. Persisted to AsyncStorage under the same
  // 'ovfr:layerVisibility' key web's useLayerVisibility (src/db/useSettings.ts)
  // uses -- previously a plain useState(LAYER_DEFAULTS) with NO persistence
  // at all, so every toggle silently reverted to LAYER_DEFAULTS on next app
  // launch. Went unnoticed for toggles whose default is already `true`
  // (aerodromes, obstacles, etc.) and was only visibly reported for Wind
  // Arrows (default `false`) -- but the gap affects every single layer here
  // (hillshade, contours, traffic, satellite, activity/glider, terrainColor
  // included), not just wind (2026-09-13).
  const [layers, setLayers]           = useState<LayerState>(LAYER_DEFAULTS)
  const layersLoadedRef = React.useRef(false)
  useEffect(() => {
    settingsDb.get<Partial<LayerState>>('ovfr:layerVisibility').then((stored) => {
      layersLoadedRef.current = true
      if (stored) {
        // 'classC' was one toggle for CTR + TMA; it is now two. Carry the old
        // choice over so nobody's layers change on upgrade.
        const legacy = (stored as { classC?: boolean }).classC
        const { classC: _drop, ...rest } = stored as Partial<LayerState> & { classC?: boolean }
        void _drop
        setLayers(l => ({
          ...l,
          ...(legacy !== undefined ? { classCtr: legacy, classCtma: legacy } : {}),
          ...rest,
        }))
      }
    }).catch(() => { layersLoadedRef.current = true })
  }, [])

  const agl  = useTerrainElevation(activePosition)
  const altitudeSource = useAltitudeSource(activePosition)
  const vario = useVarioContext()
  const varioBatteryLow = vario.status === 'connected' && vario.state != null && vario.state.batteryPercent < 20
  // mapReady flips true once (AviationMap's onMapReady, fired the moment its
  // basemap style finishes its own initial load) -- gates the first-mount
  // network fetches below (traffic, regional NOTAMs, weather-along-route,
  // wind) so they don't stack on top of the basemap's PMTiles header fetches
  // in the same cold-start burst. See HANDOFF_oom_investigation.md next-
  // steps #1 and AviationMap.tsx's onMapReady prop doc comment. Deliberately
  // never reset to false afterwards -- this only ever delays the FIRST fetch
  // of each of these session, not gate them on every subsequent re-render.
  const [mapReady, setMapReady] = useState(false)
  const handleMapReady = useCallback(() => setMapReady(true), [])

  const wind = useWind(activePosition, mapReady)

  // Airspace vertical-proximity warnings and traffic altitude comparisons
  // must use the best available altitude (BlueFly baro > internal baro >
  // GPS), never raw GPS altitude alone — GPS vertical accuracy is typically
  // far worse than barometric, which is why full airspace-ceiling warnings
  // are withheld without a real pressure sensor (see AGENTS.md's native.md
  // §8-10 reference). Falls back to GPS altitude
  // automatically when no barometric source is connected, via
  // pickBestAltitudeSource's own tier-3 fallback — no behavior change for
  // pilots without a vario/internal barometer enabled.
  // Memoized on primitive fields, not just re-spread every render: this feeds
  // useAirspaceWarnings()'s effect dependency array below. An unmemoized
  // `{ ...activePosition, altFt: ... }` literal here is a NEW object every
  // render, so that effect (which unconditionally setAlerts()s a freshly
  // built array) would fire on every render, changing its returned `alerts`
  // reference, forcing another MapScreen re-render — an infinite loop that
  // surfaced as React's "Maximum update depth exceeded" warning.
  // Touch-simulation (simFlight) has no relationship whatsoever to the
  // phone's physical barometric pressure or a connected vario — those
  // sensors read the phone's real, stationary altitude. Deferring to them
  // here silently overrode the simulated aircraft's altitude with the
  // phone's real (~constant) barometric reading, so airspace vertical
  // warnings and the VerticalProfile chart never reflected the ALT stepper
  // at all: a real repro showed a "floor 2000ft, INSIDE" alert stuck at
  // that state even after climbing the simulator to 4450ft, because the
  // hook was still evaluating the phone's real, unmoving barometric
  // altitude the whole time. Only defer to barometer/vario tiers for a
  // real GPS-tracked flight.
  const bestAltFt = simFlight.active ? (simFlight.position?.altFt ?? null) : altitudeSource.altFt
  const flyingActive = flying || simFlight.active || simPosition != null

  // Entering any flight mode (real GPS or Simulate) collapses the tab bar so
  // the map gets the full height in the air; leaving it expands the bar again.
  // Edge-triggered only: in between, the pilot can pull it up or push it down
  // manually and it is not forced back.  The bar animates both transitions.
  const { setCollapsed: setTabBarCollapsed } = useTabBarCollapsed()
  const wasFlyingRef = React.useRef(false)
  useEffect(() => {
    if (flyingActive !== wasFlyingRef.current) setTabBarCollapsed(flyingActive)
    wasFlyingRef.current = flyingActive
  }, [flyingActive, setTabBarCollapsed])

  // NM along the planned route where the aircraft currently is, and its
  // lateral deviation from that planned line — both mirror web's MapView.tsx
  // (aircraftDistNm / crossTrackNm), gated to flyingActive there too. Only
  // meaningful mid-flight: computing these from a stationary/planning-mode
  // GPS fix near the route (e.g. testing on the ground, nowhere near where
  // the route is drawn) previously badged VerticalProfile with a spurious
  // "Xnm off planned track" warning that had nothing to do with an actual
  // flight in progress.
  const currentDistNm = flyingActive && waypoints.length >= 2 && activePosition
    ? distanceAlongRouteNm(waypoints, activePosition)
    : undefined
  // Lateral deviation from the planned line — VerticalProfile's terrain/
  // airspace/MSA data is only ever sampled along the planned route (see
  // AGENTS.md discussion), so once this grows large the chart is no longer
  // showing what's actually ahead of the aircraft. Passed through so the
  // chart can badge itself rather than silently keep pretending alignment.
  const crossTrackNm = flyingActive && waypoints.length >= 2 && activePosition
    ? routeCrossTrackNm(waypoints, activePosition)
    : undefined

  const positionForAlerts = React.useMemo(() => (
    flyingActive && activePosition && bestAltFt != null
      ? {
          ...activePosition,
          altFt: bestAltFt,
          // Simulated flight: the simulator's altitude is a plain altitude with no
          // pressure/QNH behind it, so no pressure-altitude or QNH caveats apply.
          altStdFt:        simFlight.active ? null  : altitudeSource.stdAltFt,
          altQnhUncertain: simFlight.active ? false : !altitudeSource.qnhCalibrated,
          terrainFt:       agl,
        }
      : flyingActive ? activePosition : null
  ), [
    flyingActive, altitudeSource.stdAltFt, altitudeSource.qnhCalibrated, simFlight.active, agl,
    activePosition?.lat, activePosition?.lng, activePosition?.speedKts,
    activePosition?.trackDeg, activePosition?.accuracy, bestAltFt,
  ])

  // ── Look-ahead VerticalRadar for unplanned flight ──────────────────
  // While flying without a planned route, synthesise a 2-waypoint route from
  // the current GPS position along the current ground track for LOOKAHEAD_NM.
  // Recomputed when heading changes ≥10°, position moves ≥1 NM, or 20 s elapse.
  // (Tightened from ≥15°/≥3 NM/60 s — that was stale enough that obstacles
  // near the aircraft's current position, and the chart's own position
  // marker, visibly lagged reality for up to a minute/3 NM while flying.)
  const LOOKAHEAD_NM = 30
  const [lookaheadWaypoints, setLookaheadWaypoints]   = useState<RouteWaypoint[]>([])
  const [lookaheadHeadingDeg, setLookaheadHeadingDeg] = useState(0)
  const lookaheadRef = React.useRef<{ lat: number; lng: number; trackDeg: number; ts: number }>(
    { lat: 0, lng: 0, trackDeg: -999, ts: 0 },
  )
  React.useEffect(() => {
    // Mirrors web's MapView.tsx gating exactly (flyingMode === 'off' check
    // first) — without this, the look-ahead route (and therefore the
    // VerticalProfile chart) appeared as soon as GPS produced a position,
    // even before the pilot started a flight (flightModeStatus === 'off').
    if ((!flying && !simFlight.active) || waypoints.length >= 2 || !activePosition) {
      if (lookaheadWaypoints.length > 0) setLookaheadWaypoints([])
      return
    }
    const last   = lookaheadRef.current
    const now    = Date.now()
    const dPos   = distanceNm({ lat: last.lat, lng: last.lng }, { lat: activePosition.lat, lng: activePosition.lng })
    const rawDHdg = Math.abs(activePosition.trackDeg - last.trackDeg)
    const dHdg   = Math.min(rawDHdg, 360 - rawDHdg)
    const dTime  = now - last.ts
    if (last.ts > 0 && dPos < 1 && dHdg < 10 && dTime < 20_000) return
    const end = advancePosition(activePosition.lat, activePosition.lng, activePosition.trackDeg, LOOKAHEAD_NM)
    lookaheadRef.current = { lat: activePosition.lat, lng: activePosition.lng, trackDeg: activePosition.trackDeg, ts: now }
    setLookaheadWaypoints([
      { lat: activePosition.lat, lng: activePosition.lng, name: 'Position' },
      { lat: end.lat,            lng: end.lng,            name: `Hdg ${Math.round(activePosition.trackDeg)}°` },
    ])
    setLookaheadHeadingDeg(activePosition.trackDeg)
  // activePosition reference changes every tick — only re-run when the values
  // that matter for the threshold check change, not on every position update.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waypoints.length, activePosition, flying, simFlight.active])

  // Viewed flight log track (Logs segment "View" action on PlanScreen) —
  // takes priority over the live/lookahead profile: reviewing a past flight
  // is a distinct mode from planning/flying the current route.
  const { selectedLog, selectedTrack, clearView } = useFlightLogViewContext()
  // Ruler cross-section takes priority over everything else (mirrors web's
  // MapView.tsx priority order: ruler -> past-log -> planned -> look-ahead)
  // -- an active ad-hoc measurement is a more deliberate, momentary action
  // than reviewing a log or the standing planned route.
  const showRulerProfile    = rulerMode && rulerPoints.length === 2
  const showPastTrackChart  = !showRulerProfile && !!selectedLog && selectedTrack.length >= 2
  const showPlannedProfile   = !showRulerProfile && !showPastTrackChart && waypoints.length >= 2
  const showLookaheadProfile = !showRulerProfile && !showPastTrackChart && !showPlannedProfile && lookaheadWaypoints.length >= 2

  // Aircraft's live progress along the synthesised look-ahead route.
  // Previously hardcoded to 0 when passed to VerticalProfile, which pinned
  // the marker at the route-start point forever — lookaheadWaypoints[0] is
  // only re-snapped to the current position every 1 NM/10°/20 s, so between
  // snaps the aircraft visibly moves along the ground but the chart marker
  // stayed frozen at the left edge. Recomputing live against the (possibly
  // slightly stale) lookahead line keeps the marker tracking real motion,
  // since the aircraft continues along the same track the line was
  // extended from.
  const lookaheadDistNm = showLookaheadProfile && activePosition
    ? distanceAlongRouteNm(lookaheadWaypoints, activePosition)
    : 0

  // Rounded to the nearest 50 ft / 5 kt so this memo (and everything
  // downstream that keys off legOverrides — VerticalProfile's profile/
  // yMax/path useMemos) doesn't recompute on every sub-unit GPS/sim jitter.
  // MUST stay a stable array reference across renders where the rounded
  // values haven't changed — a fresh `[{...}]` literal here defeated every
  // downstream useMemo (they saw a "new" legOverrides every render) and,
  // under a burst of rapid position updates (sim stepper taps), compounded
  // into a render storm that tripped React's "Maximum update depth
  // exceeded" safety limit.
  const lookaheadAltFt   = Math.round((bestAltFt ?? activePosition?.altFt ?? 1000) / 50) * 50
  const lookaheadSpeedKts = Math.round((activePosition?.speedKts || 90) / 5) * 5
  const lookaheadLegOverrides = React.useMemo(
    () => [{ altFt: lookaheadAltFt, speedKts: lookaheadSpeedKts }],
    [lookaheadAltFt, lookaheadSpeedKts],
  )

  const [profileHeight, setProfileHeight] = useState(DEFAULT_CHART_H)
  const [mapAreaH, setMapAreaH] = useState<number | null>(null)
  // Chart-scrub → map crosshair sync (VerticalProfile/PastTrackChart touch-drag)
  // Map-side marker for a chart scrub, as [lng, lat]. Kept in a store, not
  // state: it changes several times a second while a chart is dragged, and
  // as MapScreen state every change re-rendered the whole screen. Only
  // AviationMap's cursor layer subscribes.
  const profileCursorStore = useMemo(() => createValueStore<[number, number] | null>(null), [])
  // Estimated combined height of the bottom stack (VerticalProfile header +
  // drag handle + chart, plus GaugesBar) — used to offset other floating
  // buttons that used to assume the screen bottom was empty.
  const GAUGES_BAR_H = 56
  const SIM_PANEL_H  = 110  // approx height of SimControlPanel when shown
  const PROFILE_CHROME_H = 22 + 34  // drag handle + header row
  const bottomStackH = GAUGES_BAR_H
    + (simFlight.active ? SIM_PANEL_H : 0)
    + ((showRulerProfile || showPlannedProfile || showLookaheadProfile || showPastTrackChart) ? PROFILE_CHROME_H + profileHeight : 0)
  // Right-side button column/row anchored from the TOP (below the status
  // bar / notch), stacking down in portrait or leftward in landscape from
  // that fixed upper-right point -- rather than bottom-anchored and growing
  // upward, which put the topmost (first) button at a height that shifted
  // whenever the bottom stack (profile/gauges) changed size.
  const topRightTopOffset = insets.top + scaledTheme.space2
  // Portrait: cap how far the column can grow down so it never reaches the
  // profile/gauges stack at the true screen bottom; scrolls if it would.
  const topRightBottomOffset = bottomStackH + 8 + 24 + scaledTheme.space2
  // Prefer the measured height of the map area (flex:1, i.e. exactly the space
  // above the profile/gauges stack) over the constant-based estimate, which
  // over-reserved ~120dp and clipped Flight Mode / Locate off the column.
  const topRightMaxHeight = Math.max(
    120,
    mapAreaH != null
      ? mapAreaH - scaledTheme.space2 * 2
      : windowHeight - topRightTopOffset - topRightBottomOffset,
  )
  // Landscape has width to spare but not height -- lay the same controls
  // out as a row instead of a tall column that would need to scroll to stay
  // clear of the profile chart / off the top of the screen. Capped to the
  // screen width (minus margins) so it never runs off the left edge either.
  const isLandscape = windowWidth > windowHeight
  const topRightMaxWidth = Math.max(160, windowWidth - scaledTheme.space2 * 2)
  const stackGap = isLandscape ? { marginLeft: scaledTheme.space2 } : { marginBottom: scaledTheme.space2 }

  const nearbyFreqs   = useNearbyFrequencies(activePosition)
  const homeCoord     = useHomeAirfield(settings.homeAirfield)
  // Combined into one hook/effect/setState pass -- see usePositionAlerts.ts
  // doc comment for why (React "Maximum update depth exceeded" under two
  // simultaneous Class C transitions, 2026-09-20).
  const {
    airspaceAlerts, dismissAirspace,
    obstructionAlerts, dismissObstruction,
    airfieldAlerts, dismissAirfield,
    airspaceNotifications,
  } = usePositionAlerts(positionForAlerts, waypoints, settings.airspaceWarnLookaheadMin, settings.airspaceWarnVerticalFt)

  // Active route-leg index (mirrors web MapView.tsx's activeWpIdx). Auto-
  // advances when within 0.3 NM of the current destination waypoint.
  const [activeWpIdx, setActiveWpIdx] = useState(1)
  React.useEffect(() => {
    if (!activePosition || !flyingActive || waypoints.length < 2) return
    const destWp = waypoints[activeWpIdx]
    if (!destWp || activeWpIdx >= waypoints.length - 1) return
    if (distanceNm(activePosition, destWp) < 0.3) {
      setActiveWpIdx(i => i + 1)
    }
  }, [activePosition, flyingActive, waypoints, activeWpIdx])

  // Waypoint reminder — fire when activeWpIdx changes while flying, if the
  // new active-leg destination has a pilot-entered free-text note.
  const [reminderNote, setReminderNote] = useState<{ text: string; wpName: string } | null>(null)
  React.useEffect(() => {
    if (!flyingActive) return
    const wp = waypoints[activeWpIdx]
    if (wp?.note) {
      setReminderNote({ text: wp.note, wpName: wp.name ?? `WP${activeWpIdx + 1}` })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWpIdx])

  // Airspace ceiling auto-escalation: if within 500 ft of ceiling, raise by 2 000 ft.
  const [ceilingEscalatedMsg, setCeilingEscalatedMsg] = useState<string | null>(null)
  React.useEffect(() => {
    if (!ceilingEscalatedMsg) return
    const id = setTimeout(() => setCeilingEscalatedMsg(null), 5000)
    return () => clearTimeout(id)
  }, [ceilingEscalatedMsg])
  React.useEffect(() => {
    if (!flyingActive || !activePosition) return
    const ceilingFt = settings.airspaceCeilingFt
    const ceilingAltFt = bestAltFt ?? activePosition.altFt
    if (ceilingAltFt < ceilingFt - 500) return
    // Jump directly to a ceiling that clears the current altitude (+500 ft
    // margin) in ONE step, not a fixed +2000 per effect run. The old fixed
    // +2000 step re-triggered this same effect (its own dependency,
    // settings.airspaceCeilingFt, changes on every update() call) once per
    // render, and when the persisted ceiling was far below current altitude
    // (e.g. a stale low value from earlier manual slider testing), a single
    // climb could need a dozen+ consecutive +2000 escalations before
    // clearing -- all firing in a rapid synchronous chain that exceeded
    // React's re-render safety limit ("Maximum update depth exceeded",
    // reproduced 2026-09-13 during a Simulate-mode climb through a Class C
    // floor). Still raises by at least 2000 ft even when less would clear
    // the altitude, matching the original "round step" behaviour.
    const newCeiling = Math.min(
      Math.max(ceilingFt + 2000, Math.ceil((ceilingAltFt + 500) / 2000) * 2000),
      66000,
    )
    if (newCeiling === ceilingFt) return
    update({ airspaceCeilingFt: newCeiling })
    setCeilingEscalatedMsg(`Ceiling raised to ${newCeiling.toLocaleString()} ft`)
  }, [activePosition, bestAltFt, settings.airspaceCeilingFt, flyingActive])

  const trafficFC = useTraffic({
    enabled:  layers.traffic && mapReady,
    ownAltFt: positionForAlerts?.altFt ?? null,
    ownLat:   activePosition?.lat   ?? null,
    ownLon:   activePosition?.lng   ?? null,
  })

  // Regional (FIR-wide) NOTAMs -- restricted/danger areas, navaid outages,
  // military notices not tied to any single airport. Mirrors web's
  // MapView.tsx useRegionalNotams()/notam-circles source.
  // Fetched independent of the 'notamCircles' layer-visibility toggle --
  // that toggle only controls whether the on-map circles/polygons/points
  // *draw* (gated below, on the three FeatureCollection memos fed to
  // AviationMap's sources). The underlying data must keep flowing
  // regardless, since AirspacePopup's inline NOTAM match, useNotamWarnings,
  // and RegionalNotamsPanel/VicinityBriefSheet all depend on it -- none of
  // those are the map layer itself, and hiding the on-map circles to
  // declutter shouldn't also go blind to the same NOTAMs everywhere else.
  // Full list for the NOTAM lists (they apply their own relevance filtering
  // so they can say what they hid); map layers, tap lookups and alerts use
  // the VFR-filtered list per the shared "VFR only" preference.
  const regionalNotamsAll = useRegionalNotams(authenticated && mapReady)
  const { vfrOnly: notamVfrOnly } = useNotamPrefs()
  const regionalNotams = React.useMemo(
    () => (notamVfrOnly ? regionalNotamsAll.filter(n => !isIfrOnly(n)) : regionalNotamsAll),
    [regionalNotamsAll, notamVfrOnly],
  )
  const routeWeatherStations = useWeatherAlongRoute(waypoints, mapReady)
  // Separate lookup along the Map Ruler line -- the planned route's stations
  // would otherwise be projected onto an unrelated line. Only enabled while
  // the ruler profile is showing; the aerodrome list itself is shared with
  // the instance above (module-level cache in the hook).
  const rulerWeatherStations = useWeatherAlongRoute(
    showRulerProfile ? rulerPoints : NO_WAYPOINTS,
    mapReady && showRulerProfile,
  )
  // Regular-interval wind samples -- fills the gaps between
  // routeWeatherStations' real-station markers, which only ever exist
  // wherever an aerodrome happens to sit. Mirrors web's identical addition.
  const routeTotalNm = waypoints.length >= 2 ? distanceAlongRouteNm(waypoints, waypoints[waypoints.length - 1]) : 0
  const routeWindSamples = useWindAlongRoute(waypoints, routeTotalNm, mapReady)
  const notamCirclesFC = useMemo(() => ({
    type: 'FeatureCollection' as const,
    // Map-drawing gate only -- see regionalNotams' own comment above.
    features: !layers.notamCircles ? [] : regionalNotams
      .filter((n) => !n.polygon) // real polygon geometry (below) takes priority over the synthesized circle
      .filter((n) => n.lat !== null && n.lon !== null && n.radiusNm !== null && n.radiusNm > 0)
      .map((n) => {
        const circle = makeCirclePolygon(n.lat!, n.lon!, n.radiusNm!)
        circle.properties = {
          notamId:        n.id,
          qCode:          n.qCode ?? null,
          nmsId:          n.nmsId,
          text:           n.text,
          effective:      n.effective,
          expires:        n.expires,
          classification: n.classification,
          icaoLocation:   n.icaoLocation,
          radiusNm:       n.radiusNm,
        }
        return circle
      }),
  }), [regionalNotams, layers.notamCircles])

  // Point-only regional NOTAMs (coordinates present, no usable radius --
  // obstacle lights, single-point navaid faults). Rendered as clustered
  // pins -- see AviationMap.tsx's notamPointsFC prop / notam-points-src.
  const notamPointsFC = useMemo(() => ({
    type: 'FeatureCollection' as const,
    // Map-drawing gate only -- see regionalNotams' own comment above.
    features: !layers.notamCircles ? [] : regionalNotams
      .filter((n) => !n.polygon)
      .filter((n) => n.lat !== null && n.lon !== null && (n.radiusNm === null || n.radiusNm <= 0))
      .map((n) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [n.lon!, n.lat!] },
        properties: {
          notamId:        n.id,
          qCode:          n.qCode ?? null,
          nmsId:          n.nmsId,
          text:           n.text,
          effective:      n.effective,
          expires:        n.expires,
          classification: n.classification,
          icaoLocation:   n.icaoLocation,
        },
      })),
  }), [regionalNotams, layers.notamCircles])

  // Real-geometry regional NOTAM polygons -- see AviationMap.tsx's
  // notamPolygonsFC prop / notam-polygons-src, mirrors web's MapView.tsx
  // 'notam-polygons' source exactly. Distinct from notamCirclesFC above:
  // these are NOTAMs where NMS-API itself resolved the NOTAM text's area
  // description into actual multi-vertex Polygon/MultiPolygon geometry
  // (see apps/api/src/notam.ts's extractNotamPolygon()), e.g. a
  // cross-border military exercise box, not a single point+radius circle.
  const notamPolygonsFC = useMemo(() => ({
    type: 'FeatureCollection' as const,
    // Map-drawing gate only -- see regionalNotams' own comment above.
    features: !layers.notamCircles ? [] : regionalNotams
      .filter((n) => n.polygon !== null)
      .map((n) => ({
        type: 'Feature' as const,
        geometry: n.polygon as GeoJSON.Polygon | GeoJSON.MultiPolygon,
        properties: {
          notamId:        n.id,
          qCode:          n.qCode ?? null,
          nmsId:          n.nmsId,
          text:           n.text,
          effective:      n.effective,
          expires:        n.expires,
          classification: n.classification,
          icaoLocation:   n.icaoLocation,
        },
      })),
  }), [regionalNotams, layers.notamCircles])

  const [aerodromeFeature, setAerodromeFeature] = useState<AerodromeFeatureProps | null>(null)

  // Wind-derived favored/severity state for whichever aerodrome's popup is
  // currently open, reported up by AerodromePopup (onRunwayWind) so
  // AviationMap's own 'runway-threshold-label' layer can highlight the same
  // favored runway end, not just inside the modal panel. Mirrors web's
  // MapView.runwayWindHighlight.
  const [runwayWindHighlight, setRunwayWindHighlight] =
    useState<{ icao: string; ends: RunwayWindEnd[] } | null>(null)
  const handleRunwayWind = useCallback((icao: string, ends: RunwayWindEnd[]) => {
    setRunwayWindHighlight(ends.length > 0 ? { icao, ends } : null)
  }, [])
  const [airspaceFeatures,  setAirspaceFeatures]  = useState<AirspaceFeatureProps[]>([])
  // Ad-hoc regional NOTAM circles/polygons/points merged into the same
  // AirspacePopup as airspaceFeatures above -- see handleFeatureTap's
  // notamHits collection. Cleared together, same popup close action.
  const [regionalNotamHits, setRegionalNotamHits]  = useState<RegionalNotamHit[]>([])
  const [featureInfo,       setFeatureInfo]        = useState<FeatureInfo | null>(null)

  // GPS itself is auto-started on mount (see effect below) — position
  // tracking starts automatically as soon as permission is granted, with
  // no separate "start" gesture.
  // FlightModeSheet's "Fly" option now only toggles the flight-specific
  // extras: keep-awake, auto-follow camera, and the recenter/orientation
  // buttons. It no longer starts/stops the location watcher — GaugesBar and
  // the look-ahead Vertical Radar work regardless of whether this is on.
  const flightModeStatus: FlightModeStatus = simFlight.active ? 'sim' : flying ? 'gps' : 'off'
  const plogData = useLivePlog(activePosition, flightModeStatus, waypoints, activeWpIdx)

  // Flight log recording — auto takeoff/landing detection, mirrors web's
  // useFlightLog wiring in MapView.tsx exactly (gate position on flying mode,
  // pass nearest aerodrome ICAO for departure/arrival tagging).
  const { syncState: logSyncState, pushLog } = useFlightLogSync(authenticated)
  const { activeLogId } = useFlightLog(
    flightModeStatus !== 'off' ? activePosition : null,
    flightModeStatus,
    settings.selectedAircraftId ?? '',
    aircraftProfile?.registration ?? '',
    nearbyFreqs[0]?.icao ?? null,
  )
  const prevLogIdRef = React.useRef<string | null>(null)
  useEffect(() => {
    if (prevLogIdRef.current && !activeLogId) {
      const finishedId = prevLogIdRef.current
      flightLogsDb.getAll().then(all => {
        const doc = all.find(l => l.id === finishedId)
        if (doc && doc.endedAt > 0) pushLog(doc)
      })
    }
    prevLogIdRef.current = activeLogId
  }, [activeLogId, pushLog])

  const handleStartGpsFly = useCallback(() => {
    if (simFlight.active) simFlight.stop()
    setFlying(true); setFollowGps(true)
    KeepAwake.activateKeepAwakeAsync()
  }, [simFlight])

  // Internal touch-controlled simulation — no GPS or external simulator
  // needed. Starts at the home airfield if set, else the current real GPS
  // fix, else central Sweden. Initial heading points at the first route
  // waypoint if a route is planned, else north. Initial speed comes from
  // the selected aircraft profile's cruise IAS, else 90 kts.
  const handleStartSim = useCallback(() => {
    if (flying) { setFlying(false); setFollowGps(false); KeepAwake.deactivateKeepAwake() }
    // With a planned route, start at its departure and head along the first
    // leg (starting anywhere else would begin off-route, and at the departure
    // itself the bearing to waypoint 0 is undefined). Without one, fall back
    // to the home airfield, then the GPS fix.
    // homeCoord is a [lng, lat] tuple (see useHomeAirfield.ts), not {lat,lng}
    const hasRoute = waypoints.length >= 2
    const startPos = hasRoute
      ? { lat: waypoints[0].lat, lng: waypoints[0].lng }
      : homeCoord
        ? { lng: homeCoord[0], lat: homeCoord[1] }
        : position ? { lat: position.lat, lng: position.lng } : { lat: 59.33, lng: 18.07 }
    const startTrack = hasRoute
      ? bearingDeg(startPos, waypoints[1])
      : waypoints.length >= 1 ? bearingDeg(startPos, waypoints[0]) : 0
    const startSpeed = aircraftProfile?.cruiseIas || 90
    simFlight.start(startPos, startSpeed, startTrack, 1000)
    setFollowGps(true)
    KeepAwake.activateKeepAwakeAsync()
  }, [flying, homeCoord, position, waypoints, aircraftProfile, simFlight])

  const handleStopFlight = useCallback(() => {
    if (simFlight.active) simFlight.stop()
    setFlying(false); setFollowGps(false)
    KeepAwake.deactivateKeepAwake()
  }, [simFlight])

  // Auto-start GPS on mount — request permission once, then watch position
  // continuously for as long as this screen is mounted.
  React.useEffect(() => {
    start()
    return () => stop()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    if (status === 'denied') {
      Alert.alert('Location Permission', 'Enable location access in Settings to see your position on the map.')
    }
  }, [status])

  const handleFeatureTap = useCallback(async (features: Feature[], tapLngLat: [number, number]) => {
    // First non-airspace, non-route feature — checked BEFORE the airspace
    // point-in-polygon query below. Aerodromes/navaids/waypoints/obstacles
    // very often sit physically inside their own ATZ/CTR polygon, so querying
    // airspace first and returning early on any hit meant tapping an airport
    // almost always opened the airspace popup instead of the aerodrome one —
    // airport radio/fuel/runway info was unreachable. Point features rendered
    // directly under the tap take priority; airspace is only the fallback.
    //
    // The route's own synthetic hit features (`route-pts-circle` /
    // `route-legs-hit`, tagged `featureType: 'wp'`/`'leg'` by
    // AviationMap.tsx's routePointsGeoJSON/routeLegsGeoJSON) render on top of
    // whatever real feature they were snapped to. When a route waypoint sits
    // on an aerodrome/navaid/waypoint, that synthetic feature was always
    // first in the tap's feature array — `isAerodrome`/etc. all fail on it
    // (no `icao`/`runways`/etc.), so it fell into the generic "unknown point"
    // branch below (Add to Route) and the real aerodrome underneath was never
    // reached. AviationMap.tsx's handleMapPress already special-cases 'wp'
    // for double-tap-remove before forwarding here, so it's safe to skip past
    // it here too and let the real feature underneath open its popup.
    // Ad-hoc regional NOTAM circles/polygons/points geometrically covering
    // the tapped point -- collected up front (not treated as "the" feature
    // for priority purposes) so they can be MERGED into the same airspace
    // popup as sibling entries below, instead of shadowing/blocking a tap on
    // charted airspace or another point feature underneath them (mirrors
    // web's MapView.tsx fix, commit e1abca0 -- a large ad-hoc NOTAM area,
    // routinely tens of nm across, previously intercepted every tap within
    // its extent via an early-return here). Deduped by nmsId (NOT the
    // display id -- different issuing authorities reuse the same published
    // NOTAM number) at AirspacePopup's own render step, not here.
    const notamHits: RegionalNotamHit[] = features
      .filter(f => (f.properties ?? {}).notamId)
      .map(f => {
        const p = f.properties ?? {}
        const nmsId = String(p.nmsId ?? p.notamId ?? '')
        // Prefer the FULL, un-clipped NotamItem already held in
        // `regionalNotams` (same list useRegionalNotams() polls) over the
        // tapped feature's own queried geometry -- see notamItemRing's doc
        // comment above for why the queried geometry can be a partial
        // tile-clipped wedge/arc instead of the whole shape. Only fall back
        // to the queried geometry if this NOTAM isn't in the currently-
        // loaded regional list for some reason.
        const fullItem = regionalNotams.find(n => n.nmsId === nmsId)
        return {
          notams: [fullItem ?? {
            id:             String(p.notamId ?? ''),
            nmsId,
            text:           String(p.text ?? ''),
            effective:      (p.effective as string | null | undefined) ?? null,
            expires:        (p.expires as string | null | undefined) ?? null,
            classification: (p.classification as string | null | undefined) ?? null,
            icaoLocation:   (p.icaoLocation as string | null | undefined) ?? null,
            qCode:          (p.qCode as string | null | undefined) ?? null,
            polygon:        null,
            lat:            null,
            lon:            null,
            radiusNm:       (p.radiusNm as number | null | undefined) ?? null,
          }],
          coords: fullItem ? notamItemRing(fullItem) : notamGeometryRing(f.geometry),
        }
      })

    const feature = features.find(f => {
      const p = f.properties ?? {}
      return !isAirspace(p) && !p.notamId && p.featureType !== 'wp' && p.featureType !== 'leg'
    })
    const [tapLng, tapLat] = tapLngLat

    if (feature) {
      const p = feature.properties ?? {}

      if (isAerodrome(p)) {
        const aeroCoords = feature.geometry.type === 'Point'
          ? (feature.geometry as Point).coordinates as [number, number]
          : null
        setAerodromeFeature(aerodromePropsFromFeature(p, aeroCoords))
        return
      }
      if (feature.geometry.type === 'Point') {
        const [lng, lat] = (feature.geometry as Point).coordinates

        // Navaid (VOR / NDB)
        if (p.kind === 'VOR' || p.kind === 'NDB' || p.navaid_type) {
          setFeatureInfo({
            kind: 'navaid', name: String(p.id ?? p.name ?? ''), lngLat: [lng, lat],
            subtitle: String(p.navaid_type ?? p.kind ?? 'Navaid'),
            rows: [
              p.freq_str   ? { label: 'Frequency', value: String(p.freq_str) }  : null,
              p.has_dme    ? { label: 'DME', value: 'Yes' }                     : null,
              p.elevation_ft != null ? { label: 'Elevation', value: `${p.elevation_ft} ft` } : null,
            ].filter(Boolean) as { label: string; value: string }[],
            canAddToRoute: true,
          })
          return
        }

        // Obstacle
        if (p.kind === 'wind_turbine' || p.kind === 'tower' || p.kind === 'chimney' ||
            p.elevation_ft != null && !p.icao) {
          setFeatureInfo({
            kind: 'obstacle', name: String(p.name ?? p.kind ?? 'Obstacle'), lngLat: [lng, lat],
            subtitle: String(p.kind ?? 'Obstacle').replace(/_/g, ' '),
            rows: [
              p.elevation_ft != null ? { label: 'Elevation', value: `${p.elevation_ft} ft AMSL` } : null,
              p.height_m     != null ? { label: 'Height',    value: `${Math.round((p.height_m as number) * 3.281)} ft AGL` } : null,
            ].filter(Boolean) as { label: string; value: string }[],
            canAddToRoute: false,
          })
          return
        }

        // Waypoint (MRP / RP)
        if (p.wp_type || p.id) {
          setFeatureInfo({
            kind: 'waypoint', name: String(p.id ?? p.name ?? ''), lngLat: [lng, lat],
            subtitle: String(p.wp_type ?? 'Waypoint'),
            rows: [
              p.aerodrome ? { label: 'Aerodrome', value: String(p.aerodrome) } : null,
            ].filter(Boolean) as { label: string; value: string }[],
            canAddToRoute: true,
          })
          return
        }

        // Unknown point — add to route
        addWaypoint({ lng, lat, name: (p.icao ?? p.id ?? p.name) as string | undefined })
        return
      }
    }

    // No point feature under the tap — fall back to airspace lookup, merged
    // with any ad-hoc regional NOTAM hits collected above (mirrors web's
    // MapView.tsx step 2 exactly -- neither is an independent click-priority
    // layer over the other, both render as sibling cards in the same popup).
    // Independent of the altitude-ceiling filter and per-class layer toggles —
    // those only control what's drawn on the map, not what's reported here.
    // Always query the full dataset directly.
    const airspaces = await queryAirspaceAtPoint(tapLng, tapLat, getTileUrls().airspace)
    if (airspaces.length > 0 || notamHits.length > 0) {
      setAirspaceFeatures(airspaces)
      setRegionalNotamHits(notamHits)
    }
  }, [addWaypoint, regionalNotams])

  const handleLegTap = useCallback((afterIndex: number, pos: { lat: number; lng: number }) => {
    insertWaypoint(afterIndex, { lat: pos.lat, lng: pos.lng })
  }, [insertWaypoint])

  // ── Route planning mode — button-activated, mirrors web's "Plan route"
  // toggle. While active, every map tap adds a waypoint instead of opening
  // feature popups; ambiguous taps show a SnapPicker. ────────────────────
  // Find-a-Destination row tap "fly to" request -- AviationMap consumes
  // this via flyToTarget; nonce forces the effect even on a repeat tap of
  // the same aerodrome (identical lat/lng wouldn't otherwise re-trigger it).
  const [findDestFlyTarget, setFindDestFlyTarget] = useState<{ lat: number; lng: number; zoom?: number; nonce: number } | null>(null)
  // Fallback centre when no GPS/sim fix yet: home airfield, else Stockholm
  // -- mirrors web's FindDestPanel wiring in MapView.tsx.
  const mapCentreForFindDest = homeCoord
    ? { lat: homeCoord[1], lng: homeCoord[0] }
    : { lat: 59.33, lng: 18.07 }
  const [planningMode, setPlanningMode] = useState(false)

  // ── Shareable links: openvfr://map?ad=ESSB or ?c=<coordinate> (same
  // params as web, parsed by @open-vfr/shared/deepLink). Handles both the
  // launch URL and links opened while the app is running. Ignored while
  // flying -- follow mode owns the camera then.
  const flyingRef = React.useRef(false)
  useEffect(() => { flyingRef.current = flightModeStatus !== 'off' }, [flightModeStatus])
  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url || flyingRef.current) return
      const q = url.indexOf('?')
      const link = parseMapLink(q >= 0 ? url.slice(q) : '')
      if (!hasMapLink(link)) return
      if (link.center) setFindDestFlyTarget({ lat: link.center.lat, lng: link.center.lng, zoom: link.zoom, nonce: Date.now() })
      if (link.ad) {
        const icao = link.ad
        fetch(getTileUrls().aerodromes)
          .then(r => (r.ok ? r.json() : null))
          .then((fc: GeoJSON.FeatureCollection | null) => {
            const f = fc?.features.find(x => String((x.properties ?? {}).icao ?? '').toUpperCase() === icao)
            if (!f || f.geometry.type !== 'Point') return
            const [lng, lat] = (f.geometry as Point).coordinates
            setFindDestFlyTarget({ lat, lng, zoom: link.zoom, nonce: Date.now() })
            setAerodromeFeature(aerodromePropsFromFeature((f.properties ?? {}) as Record<string, unknown>, [lng, lat]))
          })
          .catch(() => { /* offline / missing data: link does nothing */ })
      }
    }
    Linking.getInitialURL().then(handle).catch(() => {})
    const sub = Linking.addEventListener('url', (e) => handle(e.url))
    return () => sub.remove()
  }, [])

  // Outdated-AIRAC warning (re-checked on app foreground). Session-only
  // dismissal keyed on the exact outdated set so a newly superseded cycle
  // re-shows it.
  const { outdatedAirac, currentAirac, checking: airacChecking, recheck: recheckAirac } = useDataFreshness()
  const outdatedAiracKey = outdatedAirac.map(o => `${o.country}:${o.cycle}`).join(',')
  const [dismissedAiracKey, setDismissedAiracKey] = useState<string | null>(null)
  const [snapPicker, setSnapPicker] = useState<{ candidates: SnapCandidate[]; onPick: (wp: RouteWaypoint) => void } | null>(null)

  // ── Route-edit lock — waypoint/leg drag is disabled by default, both on
  // the ground and airborne (touchscreens can be knocked while flying, and
  // an accidental drag while panning around the map should never silently
  // move a leg). On the ground, toggling "planningMode" re-enables dragging;
  // in flight, "Adjust Route" (routeAdjustMode) does, for as long as it
  // stays toggled on — it always resets to locked the next time a flight
  // starts, so a forgotten toggle from a previous flight can't carry over.
  // Mirrors web's MapView.tsx planningMode/routeAdjustMode gating around the
  // route-line drag handlers. ─────
  const [routeAdjustMode, setRouteAdjustMode] = useState(false)

  // ── Location button: 'off' | 'passive' outside flight (Follow is the
  // flight-mode followGps state). Passive draws the own-position dot via
  // AviationMap's showOwnPosition; the camera only moves on an explicit
  // tap. Never starts logging, alerts or keep-awake (flight-only).
  const [locMode, setLocMode] = useState<'off' | 'passive'>('off')
  useEffect(() => {
    // Permission already granted -> show the dot at startup (no prompt,
    // camera untouched). Otherwise nothing until the user taps.
    Location.getForegroundPermissionsAsync()
      .then(p => { if (p.status === 'granted') setLocMode(m => (m === 'off' ? 'passive' : m)) })
      .catch(() => {})
  }, [])
  const handleLocate = useCallback(async () => {
    if (flightModeStatus !== 'off') { setFollowGps(true); return }
    let perm = await Location.getForegroundPermissionsAsync()
    if (perm.status !== 'granted' && perm.canAskAgain) perm = await Location.requestForegroundPermissionsAsync()
    if (perm.status !== 'granted') {
      setLocMode('off')
      Alert.alert('Location unavailable', 'Allow location access for OpenVFR in system settings to show your position.')
      return
    }
    setLocMode('passive')
    try {
      const pos = (await Location.getLastKnownPositionAsync({ maxAge: 60_000 }))
        ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }))
      if (pos) setFindDestFlyTarget({ lat: pos.coords.latitude, lng: pos.coords.longitude, nonce: Date.now() })
    } catch { /* no fix yet -- the dot appears once one arrives */ }
  }, [flightModeStatus])

  // In flight: return to following the aircraft once the map has been left
  // alone for FOLLOW_RETURN_MS after a pan -- a forgotten Re-center
  // otherwise leaves the map parked away from the aircraft. Not while
  // deliberately adjusting the route.
  //
  // Timer lives in a ref, re-armed straight from onUserPan: AviationMap
  // calls onUserPan on EVERY onRegionIsChanging frame of a drag, so a
  // per-pan state bump (the obvious "nonce" approach) commits dozens of
  // times per gesture in one macrotask and trips React's "Maximum update
  // depth exceeded". setFollowGps(false) is a no-op once already false.
  const followReturnTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const followReturnArmableRef = React.useRef(false)
  followReturnArmableRef.current = flightModeStatus !== 'off' && !routeAdjustMode
  const clearFollowReturn = useCallback(() => {
    if (followReturnTimerRef.current) { clearTimeout(followReturnTimerRef.current); followReturnTimerRef.current = null }
  }, [])
  const handleUserPan = useCallback(() => {
    setFollowGps(false)
    clearFollowReturn()
    if (!followReturnArmableRef.current) return
    followReturnTimerRef.current = setTimeout(() => {
      followReturnTimerRef.current = null
      if (followReturnArmableRef.current) setFollowGps(true)
    }, FOLLOW_RETURN_MS)
  }, [clearFollowReturn])
  // Cancel a pending return when following resumes some other way, the
  // flight ends, route-adjust starts, or the screen unmounts.
  useEffect(() => {
    if (followGps || flightModeStatus === 'off' || routeAdjustMode) clearFollowReturn()
  }, [followGps, flightModeStatus, routeAdjustMode, clearFollowReturn])
  useEffect(() => clearFollowReturn, [clearFollowReturn])
  useEffect(() => {
    if (!flyingActive) setRouteAdjustMode(false)
  }, [flyingActive])
  const routeEditLocked = flyingActive ? !routeAdjustMode : !planningMode
  // Edit sessions run while route editing is unlocked; leaving it applies the
  // pending changes (nothing is discarded silently).
  useEffect(() => {
    setEditSessionArmed(!routeEditLocked)
    if (routeEditLocked) applyEditSession()
  }, [routeEditLocked, setEditSessionArmed, applyEditSession])

  const handlePlanTap = useCallback((wp: RouteWaypoint) => {
    addWaypoint(wp)
  }, [addWaypoint])

  const handlePlanCandidates = useCallback((candidates: SnapCandidate[]) => {
    setSnapPicker({ candidates, onPick: handlePlanTap })
  }, [handlePlanTap])

  const handleWaypointMove = useCallback((index: number, pos: { lat: number; lng: number }) => {
    updateWaypoint(index, pos)
  }, [updateWaypoint])

  // Existing waypoint drag released near 2+ snap targets — ambiguous, show
  // picker; picking replaces the waypoint's position (mirrors web's
  // commitDrag "replaceMode" snapPicker branch).
  const handleWaypointMoveCandidates = useCallback((index: number, candidates: SnapCandidate[]) => {
    setSnapPicker({ candidates, onPick: (wp) => updateWaypoint(index, wp) })
  }, [updateWaypoint])

  // Leg-midpoint drag-insert resolved unambiguously (raw point or single
  // snap target) — insert directly, same as a leg tap.
  const handleLegInsert = useCallback((afterIndex: number, wp: RouteWaypoint) => {
    insertWaypoint(afterIndex, wp)
  }, [insertWaypoint])

  // Leg-midpoint drag-insert near 2+ snap targets — show picker; picking
  // inserts the chosen candidate.
  const handleLegInsertCandidates = useCallback((afterIndex: number, candidates: SnapCandidate[]) => {
    setSnapPicker({ candidates, onPick: (wp) => insertWaypoint(afterIndex, wp) })
  }, [insertWaypoint])

  // Long-hold-in-place on a route waypoint's drag handle — mirrors web's
  // stationary-tap-in-adjust-mode → WpActionMenu (Direct To / Remove /
  // Cancel), NOT the generic bare-point Save Waypoint popup. Previously this
  // routed into longPressMenu (Save Waypoint only, no Remove) — indistinguishable
  // from long-pressing empty map, so grabbing a route waypoint and releasing
  // without noticeable movement (a very easy accidental gesture) surfaced a
  // confusing "Save Waypoint" prompt instead of a route-waypoint action.
  const [wpActionMenu, setWpActionMenu] = useState<{ lat: number; lng: number; wpIdx: number } | null>(null)
  const handleWaypointLongPress = useCallback((index: number, lat: number, lng: number) => {
    setWpActionMenu({ lat, lng, wpIdx: index })
  }, [])

  const { waypoints: userWaypoints, saveWaypoint } = useUserWaypointContext()
  const userWaypointsFC = useMemo<FeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: userWaypoints.map(w => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [w.lng, w.lat] },
      properties: { name: w.name, id: w.id },
    })),
  }), [userWaypoints])

  // Map-line coords for the viewed flight log (selectedLog/selectedTrack
  // sourced above near showPastTrackChart)
  const pastTrack = useMemo<[number, number][]>(
    () => selectedTrack.map(p => [p.lng, p.lat] as [number, number]),
    [selectedTrack],
  )

  // Chart scrub distance (NM) -> map marker, along whichever line the visible
  // chart shows: ruler, viewed past log (mirrors showPastTrackChart's own
  // priority), look-ahead, then the planned route.
  const profileCursorFor = useCallback((nm: number): [number, number] | null => {
    if (showRulerProfile) {
      const c = coordinateAlongRouteNm(rulerPoints, nm)
      return [c.lng, c.lat]
    }
    if (showPastTrackChart) {
      const c = coordAlongTrack(selectedTrack, nm)
      return [c.lng, c.lat]
    }
    if (showLookaheadProfile && lookaheadWaypoints.length >= 2) {
      const c = coordinateAlongRouteNm(lookaheadWaypoints, nm)
      return [c.lng, c.lat]
    }
    if (showPlannedProfile && waypoints.length >= 2) {
      const c = coordinateAlongRouteNm(waypoints, nm)
      return [c.lng, c.lat]
    }
    return null
  }, [showRulerProfile, rulerPoints, showPastTrackChart, selectedTrack, showLookaheadProfile, lookaheadWaypoints, showPlannedProfile, waypoints])
  const handleProfileHover = useCallback((nm: number | null) => {
    profileCursorStore.set(nm == null ? null : profileCursorFor(nm))
  }, [profileCursorStore, profileCursorFor])
  // A marker left over from a chart that's no longer shown would sit on the
  // wrong line: clear it whenever the source line changes.
  useEffect(() => { profileCursorStore.set(null) }, [profileCursorFor, profileCursorStore])

  // Long-press menu — offers "Save Waypoint" for any long-pressed map point
  // (bare point or existing route waypoint alike; a tap on an existing
  // feature still routes straight through addWaypoint elsewhere, same as
  // before — this menu only applies to a long-hold). "Add to Route" was
  // removed from here entirely — planning mode / feature-tap already cover
  // adding to the route, and it doesn't make sense at all for an existing
  // route waypoint.
  const [longPressMenu, setLongPressMenu] = useState<{ lat: number; lng: number } | null>(null)
  const [savingWpAt,    setSavingWpAt]    = useState<{ lat: number; lng: number } | null>(null)
  const [wpSaveName,    setWpSaveName]    = useState('')

  const handleLongPress = useCallback((feature: Feature) => {
    if (feature.geometry.type === 'Point') {
      const [lng, lat] = (feature.geometry as Point).coordinates
      setLongPressMenu({ lat, lng })
    }
  }, [])

  const handleConfirmSaveWaypoint = useCallback(() => {
    if (!savingWpAt || !wpSaveName.trim()) return
    saveWaypoint({
      id:        Crypto.randomUUID(),
      name:      wpSaveName.trim(),
      lat:       savingWpAt.lat,
      lng:       savingWpAt.lng,
      folder:    '',
      updatedAt: Date.now(),
    })
    setSavingWpAt(null); setWpSaveName('')
  }, [savingWpAt, wpSaveName, saveWaypoint])

  const handleLayerChange = useCallback((key: keyof LayerState, on: boolean) => {
    setLayers(l => {
      const next = { ...l, [key]: on }
      // Fire-and-forget persist -- mirrors useSettings.ts's update() pattern.
      // Only meaningful once the initial load above has resolved (or failed);
      // writing before that could race the load and get clobbered the same
      // way web's useLayerVisibility guards against (see its hasUserEditedRef
      // comment) -- not adding that same guard here since the load above sets
      // layersLoadedRef synchronously in the .then/.catch before any UI could
      // plausibly fire a toggle, but kept as an explicit signal for future
      // readers rather than a silent assumption.
      settingsDb.set('ovfr:layerVisibility', next).catch(() => {})
      return next
    })
  }, [])
  // Satellite imagery is a planning-only basemap: its provider's terms class
  // aircraft navigation as a "High Risk Activity" the imagery is not intended
  // for, and it's the wrong basemap for reading airspace in flight anyway.
  // Entering any flight mode (real GPS or Simulate) forces vector; the
  // Satellite option in MapDisplaySheet is disabled until the flight ends.
  // handleLayerChange persists the change, so the app also comes back up in
  // vector mode after a mid-flight restart. Mirrors web's MapView.
  useEffect(() => {
    if (flyingActive && layers.satellite) handleLayerChange('satellite', false)
  }, [flyingActive, layers.satellite, handleLayerChange])

  // Terrain-layer memory lock: hillshade (~231MB) + contours (~117MB) PMTiles
  // sources are sticky-mounted in AviationMap (MapLibre Native throws "id
  // cannot be changed" if unmounted/re-added) and their visibility persists
  // to AsyncStorage, so a pilot who ever enables them gets them back on at
  // the very next cold restart -- the highest memory-pressure moment, when
  // auth/session restore and initial data sync are also competing for RAM.
  // A real OutOfMemoryError from this exact combination was already caught
  // on-device (see AviationMap.tsx's readyStage doc comment and
  // apps/native/.scratch/oom-investigation.md) even with staggered mount
  // timing. Locking them off by device RAM tier (see deviceMemory.ts) is the
  // same adaptive-feature-gating technique as the satellite lock above,
  // applied to the heaviest optional map layers instead of a flight-mode
  // gate. landuse (~87MB, default-on) is excluded from this lock -- much
  // lighter, and locking a default-on layer would be a bigger UX regression
  // for comparatively little memory saved.
  const terrainMemoryLocked = useMemo(() => isLowMemoryDevice(), [])
  useEffect(() => {
    if (!terrainMemoryLocked) return
    if (layers.hillshade) handleLayerChange('hillshade', false)
    if (layers.contours) handleLayerChange('contours', false)
    if (layers.terrainColor) handleLayerChange('terrainColor', false)
  }, [terrainMemoryLocked, layers.hillshade, layers.contours, layers.terrainColor, handleLayerChange])

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <BaroPromptModal />
      <View style={styles.mapContainer} onLayout={(e) => setMapAreaH(Math.round(e.nativeEvent.layout.height))}>
        <AviationMap
          gpsPosition={activePosition}
          simActive={simPosition != null}
          waypoints={waypoints}
          activeRouteId={activeRouteId}
          routeFitNonce={routeFitNonce}
          airspaceCeilingFt={settings.airspaceCeilingFt}
          distanceUnit={settings.units.distance}
          showClassCtr={layers.classCtr}
          showClassCtma={layers.classCtma}
          showClassG={layers.classG}
          showRestricted={layers.restricted}
          showActivity={layers.activity}
          showAerodromes={layers.aerodromes}
          showNavaids={layers.navaids}
          showWaypoints={layers.waypoints}
          showObstacles={layers.obstacles}
          showRunways={layers.runways}
          runwayWindHighlight={runwayWindHighlight}
          showLandmarks={layers.landmarks}
          // Terrain layers are never drawn over satellite imagery (see
          // MapDisplaySheet's Terrain section).
          showLanduse={layers.landuse && !layers.satellite}
          showHillshade={layers.hillshade && !layers.satellite}
          showTerrainColor={layers.terrainColor && !layers.satellite}
          terrainColorRefAltFt={settings.terrainColorRefAltFt}
          showContours={layers.contours && !layers.satellite}
          showWind={layers.wind}
          trafficFC={trafficFC}
          notamCirclesFC={notamCirclesFC}
          notamPointsFC={notamPointsFC}
          notamPolygonsFC={notamPolygonsFC}
          userWaypointsFC={userWaypointsFC}
          basemapMode={layers.satellite ? 'satellite' : 'vector'}
          flyToTarget={findDestFlyTarget}
          initialCenter={homeCoord ?? undefined}
          initialZoom={homeCoord ? 11 : undefined}
          autoZoom={settings.autoZoom}
          trajectoryNm={settings.trajectoryNm}
          trajectoryMode={settings.trajectoryMode ?? 'time'}
          followGps={followGps}
          onUserPan={handleUserPan}
          showOwnPosition={locMode === 'passive' && !flyingActive}
          // Aircraft icon only in flight (or with a sim/external feed); on
          // the ground the locate button's Passive dot is the one position
          // marker, and Off shows none.
          showAircraft={flyingActive}
          mapOrientation={mapOrientation}
          onFeatureTap={handleFeatureTap as (features: Feature[], lngLat: [number,number]) => void}
          onLongPress={handleLongPress}
          onWaypointMove={handleWaypointMove}
          onWaypointMoveCandidates={handleWaypointMoveCandidates}
          onWaypointLongPress={handleWaypointLongPress}
          onWaypointRemove={removeWaypoint}
          onLegTap={handleLegTap}
          onLegInsert={handleLegInsert}
          onLegInsertCandidates={handleLegInsertCandidates}
          editLocked={routeEditLocked}
          planningMode={planningMode}
          onPlanTap={handlePlanTap}
          onPlanCandidates={handlePlanCandidates}
          routeVisible={routeVisible}
          pastTrack={pastTrack}
          profileCursorStore={profileCursorStore}
          rulerMode={rulerMode}
          rulerPoints={rulerPoints}
          onRulerTap={setRulerPoints}
          onMapReady={handleMapReady}
        />

        {snapPicker && (
          <SnapPicker
            candidates={snapPicker.candidates}
            onPick={snapPicker.onPick}
            onClose={() => setSnapPicker(null)}
          />
        )}

        {/* Long-press action menu — bare-point long-press offers a choice
            instead of silently adding to route (matches web's right-click
            context-menu pattern, adapted to touch). */}
        {longPressMenu && (
          <View style={styles.longPressMenu}>
            <Text style={styles.longPressMenuCoord}>
              {longPressMenu.lat.toFixed(5)}, {longPressMenu.lng.toFixed(5)}
            </Text>
            <TouchableOpacity
              style={styles.longPressMenuBtn}
              onPress={() => { setSavingWpAt(longPressMenu); setLongPressMenu(null); setWpSaveName('') }}
            >
              <Ionicons name="bookmark-outline" size={16} color={theme.accentBlue} />
              <Text style={styles.longPressMenuBtnTxt}>Save Waypoint</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.longPressMenuCancel} onPress={() => setLongPressMenu(null)}>
              <Text style={styles.longPressMenuCancelTxt}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Route-waypoint action menu \u2014 stationary grab-and-release on an
            existing route waypoint (mirrors web's WpActionMenu). */}
        {wpActionMenu && (
          <View style={styles.longPressMenu}>
            <Text style={styles.longPressMenuCoord}>
              WP {wpActionMenu.wpIdx + 1}
            </Text>
            {wpActionMenu.wpIdx > activeWpIdx && (
              <TouchableOpacity
                style={styles.longPressMenuBtn}
                onPress={() => { setActiveWpIdx(wpActionMenu.wpIdx); setWpActionMenu(null) }}
              >
                <Ionicons name="airplane-outline" size={16} color={theme.accentBlue} />
                <Text style={styles.longPressMenuBtnTxt}>Direct To</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.longPressMenuBtn}
              onPress={() => { removeWaypoint(wpActionMenu.wpIdx); setWpActionMenu(null) }}
            >
              <Ionicons name="close-outline" size={16} color={theme.accentBlue} />
              <Text style={styles.longPressMenuBtnTxt}>Remove</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.longPressMenuCancel} onPress={() => setWpActionMenu(null)}>
              <Text style={styles.longPressMenuCancelTxt}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Save-waypoint name prompt — rendered as a proper Modal (not an
            absolute overlay on top of the MapLibre surface) so Android's
            adjustResize keyboard handling actually applies — matches
            RouteLibrarySheet/UserWaypointLibrarySheet's Modal pattern. */}
        <NativeSheet
          isPresented={!!savingWpAt}
          onDismiss={() => { setSavingWpAt(null); setWpSaveName('') }}
          title="Save waypoint"
          testID="save-waypoint-sheet"
        >
          <View style={{ paddingHorizontal: scaledTheme.space4, paddingTop: scaledTheme.space3, gap: scaledTheme.space2 }}>
          <Text style={styles.longPressMenuCoord}>
            Save waypoint at {savingWpAt?.lat.toFixed(5)}, {savingWpAt?.lng.toFixed(5)}
          </Text>
          <TextInput
            style={styles.wpNameInput}
            value={wpSaveName}
            onChangeText={setWpSaveName}
            placeholder="Name"
            placeholderTextColor={theme.textFaint}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={handleConfirmSaveWaypoint}
          />
          <View style={{ flexDirection: 'row', gap: scaledTheme.space2 }}>
            <TouchableOpacity style={styles.longPressMenuBtn} onPress={handleConfirmSaveWaypoint}>
              <Text style={styles.longPressMenuBtnTxt}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.longPressMenuCancel} onPress={() => { setSavingWpAt(null); setWpSaveName('') }}>
              <Text style={styles.longPressMenuCancelTxt}>Cancel</Text>
            </TouchableOpacity>
          </View>
          </View>
        </NativeSheet>

        {/* Consolidated notification stack — top-centre, severity-ordered */}
        <NotificationCenter
          airspaceAlerts={airspaceAlerts}
          onDismissAirspace={dismissAirspace}
          obstructionAlerts={obstructionAlerts}
          onDismissObstruction={dismissObstruction}
          airfieldAlerts={airfieldAlerts}
          onDismissAirfield={dismissAirfield}
          airspaceNotifications={airspaceNotifications}
          ceilingMsg={ceilingEscalatedMsg}
          reminderNote={reminderNote}
          onDismissReminder={() => setReminderNote(null)}
        />

        {/* Viewed flight log banner — Logs segment "View" action on PlanScreen */}
        {selectedLog && (
          <View style={[styles.pastTrackBanner, { top: scaledTheme.space2 }]}>
            <Ionicons name="navigate-outline" size={13} color="#c4b5fd" />
            <Text style={styles.pastTrackBannerTxt} numberOfLines={1}>
              {selectedLog.departureIcao || '?'} → {selectedLog.arrivalIcao || '?'} · {selectedLog.distanceNm.toFixed(0)} NM
            </Text>
            <TouchableOpacity onPress={clearView} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={15} color={theme.textMuted} />
            </TouchableOpacity>
          </View>
        )}

        {/* Outdated-AIRAC warning -- non-blocking, stacked under the log banner */}
        {outdatedAirac.length > 0 && dismissedAiracKey !== outdatedAiracKey && (
          <View style={[styles.pastTrackBanner, styles.airacBanner, { top: scaledTheme.space2 + (selectedLog ? 44 : 0) }]}>
            <Ionicons name="warning-outline" size={13} color={theme.statusWarn} />
            <Text style={styles.pastTrackBannerTxt} numberOfLines={2}>
              Airspace data outdated — {outdatedAirac.map(o => `${o.country.toUpperCase()} AIRAC ${o.cycle}`).join(', ')} (current {currentAirac}). Verify against official AIP.
            </Text>
            <TouchableOpacity onPress={recheckAirac} disabled={airacChecking} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="refresh" size={15} color={airacChecking ? theme.textFaint : theme.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setDismissedAiracKey(outdatedAiracKey)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={15} color={theme.textMuted} />
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Map controls — lower right, outside MapLibre GL surface. Offset above
          the VerticalProfile + GaugesBar stack (position:absolute buttons don't
          reflow with the flex layout below). VicinityBriefSheet trigger stacked
          above the layers button — replaces the former separate Frequency /
          Regional NOTAMs / Weather Along Route buttons (three stacked icons
          eating vertical space and, on small screens, pushing the column off
          the top of the screen) with one consolidated Freq/Wx/NOTAM sheet. */}
      <View
        style={[
          styles.topRight,
          isLandscape
            ? { top: topRightTopOffset, maxWidth: topRightMaxWidth }
            : { top: topRightTopOffset, maxHeight: topRightMaxHeight },
        ]}
        pointerEvents="box-none"
      >
      <ScrollView
        horizontal={isLandscape}
        style={isLandscape ? { maxWidth: topRightMaxWidth } : { maxHeight: topRightMaxHeight }}
        contentContainerStyle={{
          flexDirection: isLandscape ? 'row-reverse' : 'column',
          alignItems: isLandscape ? 'center' : 'flex-end',
        }}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        pointerEvents="box-none"
      >
        {/* Stack order, top to bottom, grouped by purpose with the most-used
            controls nearest the thumb: lookup (briefing, find destination),
            route planning (plan, ruler, route lock), map view (layers,
            orientation), then flight (live plog, flight mode) and finally
            Locate at the very bottom. */}
        <View style={stackGap}>
          <VicinityBriefSheet
            nearby={nearbyFreqs}
            regionalNotams={regionalNotamsAll}
            waypoints={waypoints}
            position={activePosition}
            routeVisible={routeVisible}
            homeIcao={settings.homeAirfield || undefined}
          />
        </View>
        <View style={stackGap}>
          <FindDestinationSheet
            center={activePosition ? { lat: activePosition.lat, lng: activePosition.lng, altFt: activePosition.altFt } : mapCentreForFindDest}
            homeIcao={settings.homeAirfield || null}
            aircraftProfile={aircraftProfile}
            onFlyTo={(lat, lng) => setFindDestFlyTarget({ lat, lng, nonce: Date.now() })}
            onAddToRoute={(wp) => { addWaypoint(wp); setPlanningMode(true) }}
          />
        </View>
        <View style={[styles.planRow, { flexDirection: isLandscape ? 'row' : 'column', alignItems: isLandscape ? 'center' : 'flex-end' }, stackGap]}>
          <TouchableOpacity
            style={[styles.iconBtn, planningMode && styles.iconBtnActive]}
            onPress={() => setPlanningMode(m => !m)}
          >
            <MaterialCommunityIcons name="map-marker-path" size={18} color={planningMode ? theme.accentBlue : theme.textPrimary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.iconBtn, rulerMode && styles.iconBtnActive]}
            onPress={() => { setRulerMode(m => !m); setRulerPoints([]) }}
          >
            <MaterialCommunityIcons name="ruler" size={18} color={rulerMode ? theme.accentBlue : theme.textPrimary} />
          </TouchableOpacity>
          {flightModeStatus !== 'off' && (
            <TouchableOpacity
              style={[styles.iconBtn, routeAdjustMode && styles.iconBtnActive]}
              onPress={() => setRouteAdjustMode(v => !v)}
            >
              <Ionicons
                name={routeAdjustMode ? 'lock-open-outline' : 'lock-closed-outline'}
                size={18}
                color={routeAdjustMode ? theme.accentBlue : theme.textPrimary}
              />
            </TouchableOpacity>
          )}
        </View>
        <View style={stackGap}>
          <MapDisplaySheet
            layers={layers}
            ceilingFt={settings.airspaceCeilingFt}
            autoZoom={settings.autoZoom}
            onLayerChange={handleLayerChange}
            onCeilingChange={(ft) => update({ airspaceCeilingFt: ft })}
            onAutoZoomChange={(on) => update({ autoZoom: on })}
            terrainColorRefAltFt={settings.terrainColorRefAltFt}
            onTerrainColorRefAltFtChange={(ft) => update({ terrainColorRefAltFt: ft })}
            inFlight={!!activePosition && activePosition.altFt > 0}
            satelliteLocked={flyingActive}
            terrainMemoryLocked={terrainMemoryLocked}
          />
        </View>
        {flightModeStatus !== 'off' && (
          <View style={stackGap}>
            <TouchableOpacity
              style={styles.iconBtn}
              onPress={() => setMapOrientation(o => o === 'north' ? 'track' : 'north')}
            >
              <Text style={styles.orientTxt}>
                {mapOrientation === 'track' ? '↑TRK' : '↑N'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
        {flightModeStatus !== 'off' && waypoints.length >= 2 && (
          <View style={stackGap}>
            <LivePlogPanel waypoints={waypoints} activeWpIdx={activeWpIdx} plogData={plogData} />
          </View>
        )}
        <View style={stackGap}>
          <FlightModeSheet
            status={flightModeStatus}
            onStartGps={handleStartGpsFly}
            onStartSim={handleStartSim}
            onStop={handleStopFlight}
          />
        </View>
        <View style={stackGap}>
          <TouchableOpacity
            style={[styles.iconBtn, (flightModeStatus !== 'off' ? followGps : locMode === 'passive') && styles.iconBtnActive]}
            onPress={handleLocate}
            onLongPress={() => { if (flightModeStatus === 'off') setLocMode('off') }}
            accessibilityLabel={flightModeStatus !== 'off' ? 'Re-centre on aircraft' : locMode === 'passive' ? 'Centre on my position. Long-press to turn location off.' : 'Show my position'}
          >
            <Ionicons
              name={locMode === 'passive' || flightModeStatus !== 'off' ? 'locate' : 'locate-outline'}
              size={18}
              color={(flightModeStatus !== 'off' ? followGps : locMode === 'passive') ? theme.accentBlue : theme.textPrimary}
            />
          </TouchableOpacity>
        </View>
      </ScrollView>
      </View>

      {/* Route edit session: opens on the first edit in planning mode, stays
          for every change, then Apply keeps them (unsaved) or Cancel restores. */}
      {editSessionActive && (
        <RouteEditBanner
          bottom={scaledTheme.space3 + bottomStackH}
          canUndo={canUndo} canRedo={canRedo}
          onUndo={undoRoute} onRedo={redoRoute}
          onCancel={cancelEditSession} onApply={applyEditSession}
        />
      )}

      {/* Re-center / orientation — also outside GL surface. Offset above the
          VerticalProfile + GaugesBar stack, which now occupies the true
          screen bottom (these buttons used a fixed bottom before that stack existed). */}
      {flightModeStatus !== 'off' && !followGps && (
        <TouchableOpacity style={[styles.recenterBtn, { bottom: scaledTheme.space3 + bottomStackH }]} onPress={() => setFollowGps(true)}>
          <Text style={styles.recenterText}>⊕ Re-center</Text>
        </TouchableOpacity>
      )}
      {/* FLY button replaced by FlightModeSheet, stacked in topRight with the
          layers/frequency buttons instead of its own large pill — was taking
          up too much dedicated screen space for a single toggle. */}

      {showRulerProfile && (
        <>
          <VerticalProfile
            waypoints={rulerPoints}
            legOverrides={[]}
            units={settings.units}
            airspaceCeilingFt={settings.airspaceCeilingFt}
            aircraftProfile={aircraftProfile}
            weatherStations={rulerWeatherStations}
            headerStart={<RulerHeaderStart from={rulerPoints[0]} to={rulerPoints[1]} units={settings.units} />}
            headerEnd={
              <RulerHeaderEnd from={rulerPoints[0]} to={rulerPoints[1]} aircraftProfile={aircraftProfile}
                onClear={() => { setRulerPoints([]); setRulerMode(false) }} />
            }
            height={profileHeight}
            onHeightChange={setProfileHeight}
            onHoverDistNm={handleProfileHover}
          />
        </>
      )}

      {showPlannedProfile && (
        <VerticalProfile
          waypoints={waypoints}
          legOverrides={legOverrides}
          units={settings.units}
          airspaceCeilingFt={settings.airspaceCeilingFt}
          aircraftProfile={aircraftProfile}
          headerStart={<RouteHeaderStart waypoints={waypoints} legOverrides={legOverrides} units={settings.units} cruiseKts={aircraftProfile?.cruiseIas} />}
          currentDistNm={currentDistNm}
          currentAltFt={bestAltFt ?? undefined}
          currentSpeedKts={activePosition?.speedKts}
          currentVSpeedFpm={altitudeSource.vsFtMin ?? undefined}
          crossTrackNm={crossTrackNm}
          weatherStations={routeWeatherStations}
          windSamples={routeWindSamples}
          trajectoryMode={settings.trajectoryMode ?? 'time'}
          trajectoryNm={settings.trajectoryNm}
          height={profileHeight}
          onHeightChange={setProfileHeight}
          onHoverDistNm={handleProfileHover}
        />
      )}

      {showLookaheadProfile && (
        <VerticalProfile
          title={`LOOK-AHEAD · TRK ${Math.round(lookaheadHeadingDeg)}°`}
          waypoints={lookaheadWaypoints}
          legOverrides={lookaheadLegOverrides}
          units={settings.units}
          airspaceCeilingFt={settings.airspaceCeilingFt}
          aircraftProfile={aircraftProfile}
          currentDistNm={lookaheadDistNm}
          currentAltFt={bestAltFt ?? undefined}
          currentSpeedKts={activePosition?.speedKts}
          currentVSpeedFpm={altitudeSource.vsFtMin ?? undefined}
          weatherStations={routeWeatherStations}
          trajectoryMode={settings.trajectoryMode ?? 'time'}
          trajectoryNm={settings.trajectoryNm}
          height={profileHeight}
          onHeightChange={setProfileHeight}
          onHoverDistNm={handleProfileHover}
        />
      )}

      {showPastTrackChart && (
        <PastTrackChart
          track={selectedTrack}
          height={profileHeight}
          onHeightChange={setProfileHeight}
          onHoverDistNm={handleProfileHover}
        />
      )}

      {/* Convenience "show profile" arrow — only visible when the panel is
          collapsed, since dragging back up from a fully-collapsed 0px handle
          can be fiddly to grab precisely. */}
      {(showRulerProfile || showPlannedProfile || showLookaheadProfile || showPastTrackChart) && profileHeight <= COLLAPSE_THRESHOLD && (
        <TouchableOpacity
          style={[styles.showProfileBtn, { bottom: GAUGES_BAR_H + (simFlight.active ? SIM_PANEL_H : 0) + scaledTheme.space1 }]}
          onPress={() => setProfileHeight(DEFAULT_CHART_H)}
        >
          <Ionicons name="chevron-up" size={18} color={theme.textPrimary} />
        </TouchableOpacity>
      )}

      {simFlight.active && (
        <SimControlPanel
          speedKts={simFlight.position?.speedKts ?? 0}
          altFt={simFlight.position?.altFt ?? 0}
          trackDeg={simFlight.position?.trackDeg ?? 0}
          onAdjustHeading={simFlight.adjustHeading}
          onAdjustSpeed={simFlight.adjustSpeed}
          onAdjustAlt={simFlight.adjustAlt}
          onAdvance={() => simFlight.advanceNm(1)}
          onStop={handleStopFlight}
        />
      )}

      {flightModeStatus !== 'off' && (
        <GaugesBar
          position={activePosition}
          agl={agl}
          wind={wind}
          showAgl={settings.showAltitudeAgl}
          onToggleAgl={() => update({ showAltitudeAgl: !settings.showAltitudeAgl })}
          altitudeSource={altitudeSource}
          showQnh={settings.showQnhOnPaltGauge}
          onToggleQnh={() => update({ showQnhOnPaltGauge: !settings.showQnhOnPaltGauge })}
          showLocalTime={settings.showLocalTime}
          onToggleLocalTime={() => update({ showLocalTime: !settings.showLocalTime })}
          varioBatteryLow={varioBatteryLow}
          baroExpected={settings.useInternalBarometer || vario.status === 'connected' || vario.status === 'connecting'}
        />
      )}

      <AerodromePopup
        feature={aerodromeFeature}
        onClose={() => setAerodromeFeature(null)}
        onRunwayWind={handleRunwayWind}
        regionalNotams={regionalNotamsAll}
        routeWaypoints={waypoints}
      />
      <AirspacePopup
        features={airspaceFeatures}
        regionalNotams={regionalNotamHits}
        onClose={() => { setAirspaceFeatures([]); setRegionalNotamHits([]) }}
      />
      <FeaturePopup
        feature={featureInfo}
        onClose={() => setFeatureInfo(null)}
        onAddToRoute={(lngLat, name) => addWaypoint({ lng: lngLat[0], lat: lngLat[1], name })}
      />
    </View>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  container:    { flex: 1, backgroundColor: theme.surfaceBase },
  mapContainer: { flex: 1 },
  longPressMenu: {
    position: 'absolute', left: 16, right: 16, bottom: 24,
    backgroundColor: theme.surfaceSheet, borderRadius: theme.radiusMd,
    borderWidth: 1, borderColor: theme.borderSubtle,
    padding: theme.space3, gap: theme.space2,
    overflow: 'hidden',
  },
  longPressMenuCoord: { color: theme.textMuted, fontSize: theme.textXs, marginBottom: theme.space1 },
  longPressMenuBtn: {
    flexDirection: 'row', alignItems: 'center', gap: theme.space2,
    paddingVertical: theme.space2, paddingHorizontal: theme.space2,
  },
  longPressMenuBtnTxt:    { color: theme.textPrimary, fontSize: theme.textSm, fontWeight: '600' },
  longPressMenuCancel:    { paddingVertical: theme.space2, paddingHorizontal: theme.space2, alignItems: 'center' },
  longPressMenuCancelTxt: { color: theme.textMuted, fontSize: theme.textSm },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  modalSheet: {
    backgroundColor: theme.surfaceSheet,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderBottomLeftRadius: 0, borderBottomRightRadius: 0,
    borderTopWidth: 1, borderColor: theme.borderDefault,
    padding: theme.space3, gap: theme.space2,
    overflow: 'hidden',
  },
  handle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: theme.borderDefault,
    alignSelf: 'center', marginBottom: theme.space1,
  },
  wpNameInput: {
    backgroundColor: theme.surfaceBase, borderRadius: theme.radiusSm,
    borderWidth: 1, borderColor: theme.borderSubtle,
    color: theme.textPrimary, fontSize: theme.textSm,
    paddingHorizontal: theme.space2, paddingVertical: theme.space2,
  },
  topRight: {
    position: 'absolute',
    right:    theme.space2,
    zIndex:   50,   // above MapLibre GL surface
    // Single-button rows (headset/gamepad/layers) and the multi-button
    // planRow must share one right-aligned edge. Without this, the
    // container auto-sizes to the widest child (planRow, 3 buttons wide)
    // and single 40x40 buttons default-anchor to its LEFT edge — leaving
    // the extra orientation toggle in planRow sticking out to the right,
    // unaligned with the button column above it.
    alignItems: 'flex-end',
  },
  pastTrackBanner: {
    position: 'absolute', left: theme.space2, right: theme.space2,
    zIndex: 45,
    flexDirection: 'row', alignItems: 'center', gap: theme.space2,
    backgroundColor: 'rgba(19,24,36,0.92)', borderRadius: theme.radiusMd,
    borderWidth: 1, borderColor: '#a78bfa',
    paddingHorizontal: theme.space3, paddingVertical: theme.space2,
  },
  airacBanner: { borderColor: theme.statusWarn },
  pastTrackBannerTxt: { flex: 1, color: theme.textPrimary, fontSize: theme.textXs, fontWeight: '600' },
  recenterBtn: {
    position: 'absolute', bottom: theme.space3, alignSelf: 'center',
    paddingHorizontal: theme.space4, paddingVertical: theme.space2,
    borderRadius: theme.radiusFull, backgroundColor: 'rgba(251,146,60,0.9)',
    zIndex: 30,
  },
  recenterText: { color: '#fff', fontWeight: '700', fontSize: theme.textSm },
  planRow: {
    flexDirection: 'column',
    gap: theme.space2,
    alignItems: 'flex-end',
  },
  iconBtn: {
    width:           40,
    height:          40,
    borderRadius:    theme.radiusMd,
    backgroundColor: 'rgba(19,24,36,0.90)',
    borderWidth:     1,
    borderColor:     theme.borderDefault,
    alignItems:      'center',
    justifyContent:  'center',
  },
  // Active = blue outline + blue icon on the normal dark fill, matching the
  // flight-mode and layers buttons (a solid blue fill looked out of place).
  iconBtnActive: {
    borderColor:     theme.accentBlue,
  },
  orientTxt: {
    color:      theme.textSecondary,
    fontWeight: '700',
    fontSize:   theme.textSm,
    letterSpacing: 0.5,
  },
  showProfileBtn: {
    position:        'absolute',
    alignSelf:       'center',
    width:           36,
    height:          20,
    borderRadius:    theme.radiusMd,
    backgroundColor: 'rgba(19,24,36,0.92)',
    borderWidth:     1,
    borderColor:     theme.borderDefault,
    alignItems:      'center',
    justifyContent:  'center',
    zIndex:          40,
  },
} as const
}
