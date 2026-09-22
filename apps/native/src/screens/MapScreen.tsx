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
import { View, TouchableOpacity, Text, Alert, TextInput, Modal, ScrollView, useWindowDimensions } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
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
import type { AirspaceFeatureProps } from '../components/AirspacePopup'
import { FeaturePopup }      from '../components/FeaturePopup'
import type { FeatureInfo }  from '../components/FeaturePopup'
import { useGps }            from '../hooks/useGps'
import { useRouteContext } from '../context/RouteContext'
import { SnapPicker, type SnapCandidate } from '../components/SnapPicker'
import { useTraffic }        from '../hooks/useTraffic'
import { useRegionalNotams } from '../hooks/useRegionalNotams'
import { makeCirclePolygon } from '@open-vfr/shared/geoCircle'
import { fmtNotamDate } from '@open-vfr/shared/fetchNotam'
import { NotificationCenter } from '../components/NotificationCenter'
import { queryAirspaceAtPoint } from '@open-vfr/shared/airspaceQuery'
import { getTileUrls } from '../config'
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
import { VerticalProfile, DEFAULT_CHART_H, COLLAPSE_THRESHOLD } from '../components/VerticalProfile'
import { RulerStatsBadge } from '../components/RulerStatsBadge'
import { PastTrackChart } from '../components/PastTrackChart'
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons'
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
import type { RouteWaypoint } from '../types/db'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'

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
           routeVisible, activeRouteId } = useRouteContext()
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
      if (stored) setLayers(l => ({ ...l, ...stored }))
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
      ? { ...activePosition, altFt: bestAltFt }
      : flyingActive ? activePosition : null
  ), [
    flyingActive,
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
  const lookaheadAltFt   = Math.round((activePosition?.altFt ?? 1000) / 50) * 50
  const lookaheadSpeedKts = Math.round((activePosition?.speedKts || 90) / 5) * 5
  const lookaheadLegOverrides = React.useMemo(
    () => [{ altFt: lookaheadAltFt, speedKts: lookaheadSpeedKts }],
    [lookaheadAltFt, lookaheadSpeedKts],
  )

  const [profileHeight, setProfileHeight] = useState(DEFAULT_CHART_H)
  // Chart-scrub → map crosshair sync (VerticalProfile/PastTrackChart touch-drag)
  const [profileCursorNm, setProfileCursorNm] = useState<number | null>(null)
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
  const topRightMaxHeight = Math.max(
    120,
    windowHeight - topRightTopOffset - topRightBottomOffset,
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
    if (activePosition.altFt < ceilingFt - 500) return
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
      Math.max(ceilingFt + 2000, Math.ceil((activePosition.altFt + 500) / 2000) * 2000),
      66000,
    )
    if (newCeiling === ceilingFt) return
    update({ airspaceCeilingFt: newCeiling })
    setCeilingEscalatedMsg(`Ceiling raised to ${newCeiling.toLocaleString()} ft`)
  }, [activePosition, settings.airspaceCeilingFt, flyingActive])

  const trafficFC = useTraffic({
    enabled:  layers.traffic && mapReady,
    ownAltFt: positionForAlerts?.altFt ?? null,
    ownLat:   activePosition?.lat   ?? null,
    ownLon:   activePosition?.lng   ?? null,
  })

  // Regional (FIR-wide) NOTAMs -- restricted/danger areas, navaid outages,
  // military notices not tied to any single airport. Mirrors web's
  // MapView.tsx useRegionalNotams()/notam-circles source.
  const regionalNotams = useRegionalNotams(layers.notamCircles && authenticated && mapReady)
  const routeWeatherStations = useWeatherAlongRoute(waypoints, mapReady)
  // Regular-interval wind samples -- fills the gaps between
  // routeWeatherStations' real-station markers, which only ever exist
  // wherever an aerodrome happens to sit. Mirrors web's identical addition.
  const routeTotalNm = waypoints.length >= 2 ? distanceAlongRouteNm(waypoints, waypoints[waypoints.length - 1]) : 0
  const routeWindSamples = useWindAlongRoute(waypoints, routeTotalNm, mapReady)
  const notamCirclesFC = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: regionalNotams
      .filter((n) => n.lat !== null && n.lon !== null && n.radiusNm !== null && n.radiusNm > 0)
      .map((n) => {
        const circle = makeCirclePolygon(n.lat!, n.lon!, n.radiusNm!)
        circle.properties = {
          notamId:        n.id,
          text:           n.text,
          effective:      n.effective,
          expires:        n.expires,
          classification: n.classification,
          radiusNm:       n.radiusNm,
        }
        return circle
      }),
  }), [regionalNotams])

  // Point-only regional NOTAMs (coordinates present, no usable radius --
  // obstacle lights, single-point navaid faults). Rendered as clustered
  // pins -- see AviationMap.tsx's notamPointsFC prop / notam-points-src.
  const notamPointsFC = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: regionalNotams
      .filter((n) => n.lat !== null && n.lon !== null && (n.radiusNm === null || n.radiusNm <= 0))
      .map((n) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [n.lon!, n.lat!] },
        properties: {
          notamId:        n.id,
          text:           n.text,
          effective:      n.effective,
          expires:        n.expires,
          classification: n.classification,
        },
      })),
  }), [regionalNotams])

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
    // homeCoord is a [lng, lat] tuple (see useHomeAirfield.ts), not {lat,lng}
    const startPos = homeCoord
      ? { lng: homeCoord[0], lat: homeCoord[1] }
      : position ? { lat: position.lat, lng: position.lng } : { lat: 59.33, lng: 18.07 }
    const startTrack = waypoints.length >= 1 ? bearingDeg(startPos, waypoints[0]) : 0
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
    // First non-airspace feature — checked BEFORE the airspace point-in-polygon
    // query below. Aerodromes/navaids/waypoints/obstacles very often sit
    // physically inside their own ATZ/CTR polygon, so querying airspace first
    // and returning early on any hit meant tapping an airport almost always
    // opened the airspace popup instead of the aerodrome one — airport radio/
    // fuel/runway info was unreachable. Point features rendered directly under
    // the tap take priority; airspace is only the fallback.
    const feature = features.find(f => !isAirspace(f.properties ?? {}))
    const [tapLng, tapLat] = tapLngLat

    if (feature) {
      const p = feature.properties ?? {}

      // Regional NOTAM circle -- polygon geometry, checked before the
      // Point-only branches below (which wouldn't otherwise catch it).
      if (p.notamId) {
        setFeatureInfo({
          kind: 'notam', name: String(p.notamId ?? ''), subtitle: 'NOTAM',
          rows: [
            p.effective ? { label: 'Effective', value: fmtNotamDate(String(p.effective)) ?? '' } : null,
            p.expires   ? { label: 'Expires',   value: fmtNotamDate(String(p.expires)) ?? '' }   : null,
            { label: 'Text', value: String(p.text ?? '') },
          ].filter(Boolean) as { label: string; value: string }[],
          canAddToRoute: false,
        })
        return
      }

      if (isAerodrome(p)) {
        const parse = <T,>(v: unknown): T => typeof v === 'string' ? JSON.parse(v) : v as T
        const aeroCoords = feature.geometry.type === 'Point'
          ? (feature.geometry as Point).coordinates as [number, number]
          : null
        setAerodromeFeature({
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
          lng: aeroCoords ? aeroCoords[0] : undefined,
          lat: aeroCoords ? aeroCoords[1] : undefined,
        })
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

    // No point feature under the tap — fall back to airspace lookup.
    // Independent of the altitude-ceiling filter and per-class layer toggles —
    // those only control what's drawn on the map, not what's reported here.
    // Always query the full dataset directly.
    const airspaces = await queryAirspaceAtPoint(tapLng, tapLat, getTileUrls().airspace)
    if (airspaces.length > 0) {
      setAirspaceFeatures(airspaces)
    }
  }, [addWaypoint])

  const handleLegTap = useCallback((afterIndex: number, pos: { lat: number; lng: number }) => {
    insertWaypoint(afterIndex, { lat: pos.lat, lng: pos.lng })
  }, [insertWaypoint])

  // ── Route planning mode — button-activated, mirrors web's "Plan route"
  // toggle. While active, every map tap adds a waypoint instead of opening
  // feature popups; ambiguous taps show a SnapPicker. ────────────────────
  // Find-a-Destination row tap "fly to" request -- AviationMap consumes
  // this via flyToTarget; nonce forces the effect even on a repeat tap of
  // the same aerodrome (identical lat/lng wouldn't otherwise re-trigger it).
  const [findDestFlyTarget, setFindDestFlyTarget] = useState<{ lat: number; lng: number; nonce: number } | null>(null)
  // Fallback centre when no GPS/sim fix yet: home airfield, else Stockholm
  // -- mirrors web's FindDestPanel wiring in MapView.tsx.
  const mapCentreForFindDest = homeCoord
    ? { lat: homeCoord[1], lng: homeCoord[0] }
    : { lat: 59.33, lng: 18.07 }
  const [planningMode, setPlanningMode] = useState(false)
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
  useEffect(() => {
    if (!flyingActive) setRouteAdjustMode(false)
  }, [flyingActive])
  const routeEditLocked = flyingActive ? !routeAdjustMode : !planningMode

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

  // Map-side crosshair marker position for the current chart-scrub distance
  // (profileCursorNm) — sourced from whichever mode is active: viewed past
  // log takes priority (mirrors showPastTrackChart's own priority), then
  // look-ahead, then the planned route.
  const profileCursorCoord = useMemo<[number, number] | null>(() => {
    if (profileCursorNm == null) return null
    if (showRulerProfile) {
      const c = coordinateAlongRouteNm(rulerPoints, profileCursorNm)
      return [c.lng, c.lat]
    }
    if (showPastTrackChart) {
      const c = coordAlongTrack(selectedTrack, profileCursorNm)
      return [c.lng, c.lat]
    }
    if (showLookaheadProfile && lookaheadWaypoints.length >= 2) {
      const c = coordinateAlongRouteNm(lookaheadWaypoints, profileCursorNm)
      return [c.lng, c.lat]
    }
    if (showPlannedProfile && waypoints.length >= 2) {
      const c = coordinateAlongRouteNm(waypoints, profileCursorNm)
      return [c.lng, c.lat]
    }
    return null
  }, [profileCursorNm, showRulerProfile, rulerPoints, showPastTrackChart, selectedTrack, showLookaheadProfile, lookaheadWaypoints, showPlannedProfile, waypoints])

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

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.mapContainer}>
        <AviationMap
          gpsPosition={activePosition}
          simActive={simPosition != null}
          waypoints={waypoints}
          activeRouteId={activeRouteId}
          airspaceCeilingFt={settings.airspaceCeilingFt}
          showClassC={layers.classC}
          showClassD={layers.classD}
          showClassE={layers.classE}
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
          showLanduse={layers.landuse}
          showHillshade={layers.hillshade}
          showTerrainColor={layers.terrainColor}
          showContours={layers.contours}
          showWind={layers.wind}
          trafficFC={trafficFC}
          notamCirclesFC={notamCirclesFC}
          notamPointsFC={notamPointsFC}
          userWaypointsFC={userWaypointsFC}
          basemapMode={layers.satellite ? 'satellite' : 'vector'}
          flyToTarget={findDestFlyTarget}
          initialCenter={homeCoord ?? undefined}
          initialZoom={homeCoord ? 11 : undefined}
          autoZoom={settings.autoZoom}
          trajectoryNm={settings.trajectoryNm}
          trajectoryMode={settings.trajectoryMode ?? 'time'}
          followGps={followGps}
          onUserPan={() => setFollowGps(false)}
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
          profileCursor={profileCursorCoord}
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
        <Modal visible={!!savingWpAt} transparent animationType="slide" onRequestClose={() => { setSavingWpAt(null); setWpSaveName('') }}>
          <View style={styles.modalRoot}>
          <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => { setSavingWpAt(null); setWpSaveName('') }} />
          <KeyboardAvoidingView behavior="padding" style={{ width: '100%' }}>
            <View style={styles.modalSheet}>
              <View style={styles.handle} />
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
          </KeyboardAvoidingView>
          </View>
        </Modal>

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
        <View style={stackGap}>
          <VicinityBriefSheet
            nearby={nearbyFreqs}
            regionalNotams={regionalNotams}
            waypoints={waypoints}
            position={activePosition}
            flying={flightModeStatus !== 'off'}
          />
        </View>
        <View style={stackGap}>
          <FlightModeSheet
            status={flightModeStatus}
            onStartGps={handleStartGpsFly}
            onStartSim={handleStartSim}
            onStop={handleStopFlight}
          />
        </View>
        {flightModeStatus !== 'off' && waypoints.length >= 2 && (
          <View style={stackGap}>
            <LivePlogPanel waypoints={waypoints} activeWpIdx={activeWpIdx} plogData={plogData} />
          </View>
        )}
        {/* Route planning + activate/deactivate + orientation toggle — one
            continuous vertical column with the buttons above/below, all
            right-aligned and stacked bottom-right, just above the map's
            attribution/info icon (mirrors web's toolbar). Previously an
            inline 3-across row, which stuck out past the single-button
            column above it and looked misaligned. */}
        {/* Nested route-tools group (planning/ruler/lock/orientation) --
            direction must follow the outer stack's orientation too, or it
            renders as its own little vertical pair even while every other
            item in the row sits on one horizontal line in landscape. */}
        <View style={[styles.planRow, { flexDirection: isLandscape ? 'row' : 'column', alignItems: isLandscape ? 'center' : 'flex-end' }, stackGap]}>
          <TouchableOpacity
            style={[styles.iconBtn, planningMode && styles.iconBtnActive]}
            onPress={() => setPlanningMode(m => !m)}
          >
            <MaterialCommunityIcons name="map-marker-path" size={18} color={planningMode ? '#ffffff' : theme.textPrimary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.iconBtn, rulerMode && styles.iconBtnActive]}
            onPress={() => { setRulerMode(m => !m); setRulerPoints([]) }}
          >
            <MaterialCommunityIcons name="ruler" size={18} color={rulerMode ? '#ffffff' : theme.textPrimary} />
          </TouchableOpacity>
          {flightModeStatus !== 'off' && (
            <TouchableOpacity
              style={[styles.iconBtn, routeAdjustMode && styles.iconBtnActive]}
              onPress={() => setRouteAdjustMode(v => !v)}
            >
              <Ionicons
                name={routeAdjustMode ? 'lock-open-outline' : 'lock-closed-outline'}
                size={18}
                color={routeAdjustMode ? '#ffffff' : theme.textPrimary}
              />
            </TouchableOpacity>
          )}
          {flightModeStatus !== 'off' && (
            <TouchableOpacity
              style={styles.iconBtn}
              onPress={() => setMapOrientation(o => o === 'north' ? 'track' : 'north')}
            >
              <Text style={styles.orientTxt}>
                {mapOrientation === 'track' ? '↑TRK' : '↑N'}
              </Text>
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
          />
        </View>
        <FindDestinationSheet
          center={activePosition ? { lat: activePosition.lat, lng: activePosition.lng, altFt: activePosition.altFt } : mapCentreForFindDest}
          homeIcao={settings.homeAirfield || null}
          aircraftProfile={aircraftProfile}
          onFlyTo={(lat, lng) => setFindDestFlyTarget({ lat, lng, nonce: Date.now() })}
          onAddToRoute={(wp) => { addWaypoint(wp); setPlanningMode(true) }}
        />
      </ScrollView>
      </View>

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
          <RulerStatsBadge from={rulerPoints[0]} to={rulerPoints[1]} units={settings.units} aircraftProfile={aircraftProfile}
            bottom={bottomStackH} />
          <VerticalProfile
            waypoints={rulerPoints}
            legOverrides={[]}
            units={settings.units}
            aircraftProfile={aircraftProfile}
            height={profileHeight}
            onHeightChange={setProfileHeight}
            onHoverDistNm={setProfileCursorNm}
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
          onHoverDistNm={setProfileCursorNm}
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
          onHoverDistNm={setProfileCursorNm}
        />
      )}

      {showPastTrackChart && (
        <PastTrackChart
          track={selectedTrack}
          height={profileHeight}
          onHeightChange={setProfileHeight}
          onHoverDistNm={setProfileCursorNm}
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
        />
      )}

      <AerodromePopup feature={aerodromeFeature} onClose={() => setAerodromeFeature(null)} onRunwayWind={handleRunwayWind} />
      <AirspacePopup  features={airspaceFeatures}  onClose={() => setAirspaceFeatures([])}  />
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
    backgroundColor: theme.surfacePanel, borderRadius: theme.radiusMd,
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
    backgroundColor: theme.surfacePanel,
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
  iconBtnActive: {
    backgroundColor: theme.accentBlue,
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
