/**
 * VerticalProfile — the native "Virtual Radar" vertical profile chart.
 *
 * Shows, along the planned route: terrain elevation (gradient-shaded), MSA,
 * airspace cross-sections with class/altitude labels, obstacle pictograms at
 * their true elevation, the planned altitude step-line, an optional
 * performance-projected flight path, the aircraft's live position with a
 * pitch-tilted silhouette, and forward trajectory ticks.
 *
 * Built with react-native-svg (no Recharts — that's web/DOM-only). Visual
 * design is intentionally richer than the web ComposedChart version: layered
 * terrain relief shadow, glow-halo airspace borders, real obstacle icon
 * pictograms (reusing the same PNGs as the map), and a pitch-responsive
 * aircraft silhouette.
 *
 * ── Static-pressure / barometric-altitude limitation ────────────────────────
 * See @open-vfr/shared/virtualRadarCalc header comment and AGENTS.md for the
 * full discussion. Short version: airspace boundaries defined as FL/QNH are
 * treated as literal feet AMSL and compared directly against GPS altitude —
 * a common practical approximation among EFB apps. This can be off by
 * a few hundred feet in non-standard atmospheric conditions. Always
 * cross-check your primary altimeter (set to QNH) near a boundary — this
 * chart is situational awareness, not proof of airspace compliance.
 */

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import {
  View, Text, TouchableOpacity, StyleSheet, Image, PanResponder, type LayoutChangeEvent,
} from 'react-native'
import Svg, { Path, Line as SvgLine, Circle, Defs, LinearGradient, Stop, G } from 'react-native-svg'

import type { RouteWaypoint, LegOverride, AircraftProfileDocType } from '../types/db'
import { type Units, DEFAULT_UNITS, nmToDisplay } from '../utils/units'
import {
  buildVirtualRadarProfile,
  fetchTerrainProfile,
  projectFlightPath,
  computeMsaProfile,
  terrainAt,
  type TerrainPoint,
  type MsaPoint,
  type AircraftPerfModel,
} from '@open-vfr/shared/virtualRadarCalc'
import { TILE_URLS, TILE_BASE } from '../config'
import { theme } from '../styles/theme'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  waypoints:    RouteWaypoint[]
  legOverrides: LegOverride[]
  units?:       Units
  title?: string
  aircraftProfile?: AircraftProfileDocType
  currentDistNm?: number
  currentAltFt?: number
  currentSpeedKts?: number
  currentVSpeedFpm?: number
  trajectoryMode?: 'time' | 'nm'
  /** Farthest trajectory tick distance — mirrors the map's on-map trajectory
   *  line 3rd tick (settings.trajectoryNm). The near ticks are always 1 and 3
   *  (matching the map); only the far tick is configurable. Defaults to 5,
   *  matching the map's own default. Must be kept in sync with whatever value
   *  is passed to AviationMap's trajectoryNm prop — otherwise the on-map
   *  trajectory ticks and the chart's trajectory ticks land at different
   *  distances for the same aircraft. */
  trajectoryNm?: number
  /** Chart area height in px — controlled by the parent (draggable via the
   *  handle rendered at the top of this panel). Defaults to DEFAULT_CHART_H. */
  height?: number
  /** Called continuously while dragging the resize handle, and when the
   *  collapse/expand chevron is tapped. Omit for a fixed-height, non-draggable
   *  panel (falls back to DEFAULT_CHART_H). */
  onHeightChange?: (h: number) => void
  /** Called with the distance-along-route (NM) under the finger while
   *  touch-dragging the chart plot area, and with null on release — lets
   *  the parent screen sync a crosshair marker on the map. Touch-drag
   *  equivalent of web's Recharts onMouseMove/onMouseLeave. */
  onHoverDistNm?: (nm: number | null) => void
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

export const DEFAULT_CHART_H  = 190
export const MIN_CHART_H      = 0
export const MAX_CHART_H      = 340
export const COLLAPSE_THRESHOLD = 24   // below this, treat as "collapsed"
const MARGIN_L  = 34   // room for FL/alt ticks
const MARGIN_R  = 10
const MARGIN_T  = 10
const MARGIN_B  = 18

// Obstacle icon PNGs — same assets as the map (native/assets/poi_icons/)
const OBSTACLE_ICONS: Record<string, ReturnType<typeof require>> = {
  wind_turbine: require('../../assets/poi_icons/obs-wind-turbine.png'),
  tower:        require('../../assets/poi_icons/obs-tower.png'),
  chimney:      require('../../assets/poi_icons/obs-chimney.png'),
  building:     require('../../assets/poi_icons/obs-building.png'),
}
const OBSTACLE_ICON_FALLBACK = require('../../assets/poi_icons/obs-other.png')

// Landmark icon PNGs — same assets as the map (native/assets/poi_icons/)
const LANDMARK_ICONS: Record<string, ReturnType<typeof require>> = {
  church:       require('../../assets/poi_icons/lmk-church.png'),
  mast:         require('../../assets/poi_icons/lmk-mast.png'),
  windmill:     require('../../assets/poi_icons/lmk-windmill.png'),
  water_tower:  require('../../assets/poi_icons/lmk-water-tower.png'),
  chimney:      require('../../assets/poi_icons/lmk-chimney.png'),
}
const LANDMARK_ICON_FALLBACK = require('../../assets/poi_icons/lmk-church.png')

/**
 * "Nice" axis tick step — real flight levels are always assigned in round
 * increments (500 ft is standard below the transition level), never arbitrary
 * values. Web gets this for free from Recharts' built-in nice-tick algorithm;
 * native's hand-rolled chart needs the same 1-2-5-10 stepping rule so ticks
 * land on values like FL020/FL025/FL050 instead of FL023.
 */
function niceStep(range: number, targetTicks: number): number {
  if (range <= 0) return 500
  const raw = range / targetTicks
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  let step: number
  if (norm < 1.5) step = 1
  else if (norm < 3)  step = 2
  else if (norm < 7)  step = 5
  else step = 10
  // Never go below a 500 ft step — anything finer isn't a meaningful
  // altitude increment for a VFR vertical profile.
  return Math.max(500, step * mag)
}

function niceYTicks(yMax: number, targetTicks = 5): number[] {
  const step = niceStep(yMax, targetTicks)
  const ticks: number[] = []
  for (let v = 0; v <= yMax + 1e-6; v += step) ticks.push(Math.round(v))
  return ticks
}

function getPlannedAlt(altProfile: { distNm: number; altFt: number }[], distNm: number): number {
  let alt = altProfile[0]?.altFt ?? 0
  for (const p of altProfile) {
    if (p.distNm <= distNm) alt = p.altFt
    else break
  }
  return alt
}


// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VerticalProfile({
  waypoints, legOverrides, units = DEFAULT_UNITS, title, aircraftProfile,
  currentDistNm, currentAltFt, currentSpeedKts, currentVSpeedFpm, trajectoryMode, trajectoryNm = 5,
  height = DEFAULT_CHART_H, onHeightChange, onHoverDistNm,
}: Props) {
  const [hoverNm, setHoverNm] = useState<number | null>(null)
  const [airspaceGeo, setAirspaceGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [obstacleGeo, setObstacleGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [waterGeo,    setWaterGeo]    = useState<GeoJSON.FeatureCollection | null>(null)
  const [landmarkGeo, setLandmarkGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [terrainPts, setTerrainPts]   = useState<TerrainPoint[]>([])
  const [msaPts,     setMsaPts]       = useState<MsaPoint[]>([])
  const [showProjection, setShowProjection] = useState(false)
  const [chartW,      setChartW]      = useState(0)

  const chartH    = Math.max(0, height)
  const collapsed = chartH <= COLLAPSE_THRESHOLD

  // Drag handle — resizes the chart area by adjusting `height` via onHeightChange.
  // Dragging up (negative dy) grows the chart; dragging down shrinks it toward 0
  // (fully hidden, only the header + GaugesBar below remain visible).
  //
  // IMPORTANT: the PanResponder must be created exactly once (empty deps).
  // Every onHeightChange() call during a drag flows back into this
  // component as a new `height` prop, which changes `chartH` — if chartH
  // were a dependency of the useMemo, PanResponder.create() would run again
  // *mid-gesture*, handing the native gesture recognizer a brand-new
  // responder instance with reset internal touch-tracking state. That's why
  // dragging felt like it "snapped back": most of the finger movement was
  // being discarded by these repeated resets. Live values are read through
  // refs instead of closure so the responder can stay a stable singleton.
  const chartHRef = useRef(chartH)
  chartHRef.current = chartH
  const onHeightChangeRef = useRef(onHeightChange)
  onHeightChangeRef.current = onHeightChange
  const dragStartHeightRef = useRef(chartH)
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { dragStartHeightRef.current = chartHRef.current },
    onPanResponderMove: (_, gs) => {
      const next = Math.max(MIN_CHART_H, Math.min(MAX_CHART_H, dragStartHeightRef.current - gs.dy))
      onHeightChangeRef.current?.(next)
    },
  }), [])

  const perf = useMemo((): AircraftPerfModel | null => {
    if (!aircraftProfile) return null
    const { rocSlFpm, rocCeilingFpm, serviceCeilingFt, climbIas, descentFpm, descentIas } = aircraftProfile
    if (rocSlFpm <= 0 || climbIas <= 0 || descentFpm <= 0 || descentIas <= 0) return null
    return { rocSlFpm, rocCeilingFpm: rocCeilingFpm ?? 50, serviceCeilingFt: serviceCeilingFt || 15000, climbIas, descentFpm, descentIas }
  }, [aircraftProfile])

  // Load GeoJSON once
  useEffect(() => {
    fetch(TILE_URLS.airspace).then(r => r.json()).then(setAirspaceGeo).catch(() => {})
    fetch(TILE_URLS.obstacles).then(r => r.json()).then(setObstacleGeo).catch(() => {})
    fetch(TILE_URLS.water).then(r => r.json()).then(setWaterGeo).catch(() => { /* optional layer — offline-safe no-op */ })
    fetch(TILE_URLS.landmarks).then(r => r.json()).then(setLandmarkGeo).catch(() => { /* optional layer — offline-safe no-op */ })
  }, [])

  // Fetch terrain profile whenever the route changes
  const routeKey = waypoints.map((w) => `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`).join('|')
  useEffect(() => {
    if (waypoints.length < 2) {
      setTerrainPts([])
      setMsaPts([])
      return
    }
    const controller = new AbortController()
    setTerrainPts([])
    fetchTerrainProfile(waypoints, TILE_BASE, controller.signal)
      .then((pts) => {
        setTerrainPts(pts)
        setMsaPts(computeMsaProfile(pts))
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') {
          console.warn('[VerticalProfile] terrain fetch failed:', err)
        }
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey])

  const profile = useMemo(() => {
    if (waypoints.length < 2 || !airspaceGeo || !obstacleGeo) return null
    return buildVirtualRadarProfile(waypoints, legOverrides, airspaceGeo, obstacleGeo, waterGeo ?? undefined, landmarkGeo ?? undefined)
  }, [waypoints, legOverrides, airspaceGeo, obstacleGeo, waterGeo, landmarkGeo])

  const getMsa = useMemo(() => {
    if (msaPts.length === 0) return (_d: number) => 0
    return (distNm: number): number => {
      let msa = msaPts[0]?.msaFt ?? 0
      for (const p of msaPts) {
        if (p.distNm <= distNm) msa = p.msaFt
        else break
      }
      return msa
    }
  }, [msaPts])

  const yMax = useMemo(() => {
    if (!profile) return 10000
    const planned    = Math.max(profile.maxPlannedAltFt, 1000)
    const maxTerrain = terrainPts.reduce((m, p) => Math.max(m, p.elevFt), 0)
    const raw        = Math.max(planned * 1.5, maxTerrain * 1.2, 3000)
    return Math.ceil(raw / 1000) * 1000
  }, [profile, terrainPts])

  const totalNm = profile?.totalNm ?? 0
  const plotW = Math.max(0, chartW - MARGIN_L - MARGIN_R)
  const plotH = chartH - MARGIN_T - MARGIN_B

  const xOf = useCallback((distNm: number) => MARGIN_L + (totalNm > 0 ? (distNm / totalNm) * plotW : 0), [totalNm, plotW])
  const yOf = useCallback((altFt: number) => MARGIN_T + plotH - (yMax > 0 ? (altFt / yMax) * plotH : 0), [yMax, plotH])

  // Touch-drag scrub over the chart plot area — lets the parent screen sync
  // a crosshair marker on the map (native equivalent of web's Recharts
  // onMouseMove/onMouseLeave). Singleton PanResponder for the same reason as
  // the resize-drag one above: must not be recreated mid-gesture.
  const totalNmRef = useRef(totalNm); totalNmRef.current = totalNm
  const plotWRef = useRef(plotW); plotWRef.current = plotW
  const onHoverDistNmRef = useRef(onHoverDistNm); onHoverDistNmRef.current = onHoverDistNm
  const updateHover = useCallback((locationX: number) => {
    const tNm = totalNmRef.current, pW = plotWRef.current
    if (tNm <= 0 || pW <= 0) return
    const nm = Math.max(0, Math.min(tNm, ((locationX - MARGIN_L) / pW) * tNm))
    setHoverNm(nm)
    onHoverDistNmRef.current?.(nm)
  }, [])
  const clearHover = useCallback(() => { setHoverNm(null); onHoverDistNmRef.current?.(null) }, [])
  const scrubResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => updateHover(e.nativeEvent.locationX),
    onPanResponderMove: (e) => updateHover(e.nativeEvent.locationX),
    onPanResponderRelease: () => clearHover(),
    onPanResponderTerminate: () => clearHover(),
  }), [updateHover, clearHover])

  // Departure/arrival elevation from first/last terrain sample (aerodrome elevation proxy)
  const depElevFt = terrainPts[0]?.elevFt ?? 0
  const arrElevFt = terrainPts[terrainPts.length - 1]?.elevFt ?? 0

  const projAlts = useMemo(() => {
    if (!perf || !profile || terrainPts.length === 0) return null
    return projectFlightPath(
      profile.altitudeProfile, profile.totalNm, perf,
      terrainPts.map(p => p.distNm), depElevFt, arrElevFt,
    )
  }, [perf, profile, terrainPts, depElevFt, arrElevFt])

  // Terrain silhouette path + relief-shadow duplicate (offset down/right)
  const terrainPath = useMemo(() => {
    if (terrainPts.length === 0 || plotW <= 0) return { fill: '', shadow: '', outline: '' }
    const pts = terrainPts.map(p => `${xOf(p.distNm).toFixed(1)},${yOf(p.elevFt).toFixed(1)}`)
    const bottomY = MARGIN_T + plotH
    const fill = `M${xOf(0).toFixed(1)},${bottomY} L${pts.join(' L')} L${xOf(totalNm).toFixed(1)},${bottomY} Z`
    const outline = `M${pts.join(' L')}`
    // Relief shadow: same silhouette, offset +2,+3 px, drawn first (behind) at low opacity
    const shadowPts = terrainPts.map(p => `${(xOf(p.distNm) + 2).toFixed(1)},${(yOf(p.elevFt) + 3).toFixed(1)}`)
    const shadow = `M${xOf(0).toFixed(1)},${bottomY} L${shadowPts.join(' L')} L${xOf(totalNm).toFixed(1)},${bottomY} Z`
    return { fill, shadow, outline }
  }, [terrainPts, plotW, plotH, xOf, yOf, totalNm])

  // MSA dashed path
  const msaPath = useMemo(() => {
    if (msaPts.length === 0) return ''
    const visible = msaPts.filter(p => p.msaFt > 0)
    if (visible.length === 0) return ''
    return `M${visible.map(p => `${xOf(p.distNm).toFixed(1)},${yOf(p.msaFt).toFixed(1)}`).join(' L')}`
  }, [msaPts, xOf, yOf])

  // Planned altitude step-line path
  const plannedPath = useMemo(() => {
    if (!profile || profile.altitudeProfile.length === 0) return ''
    return `M${profile.altitudeProfile.map(p => `${xOf(p.distNm).toFixed(1)},${yOf(p.altFt).toFixed(1)}`).join(' L')}`
  }, [profile, xOf, yOf])

  // Projected flight path — split into safe (cyan) / below-MSA (red) segments
  const { projSafePath, projDangerPath } = useMemo(() => {
    if (!projAlts || terrainPts.length === 0) return { projSafePath: '', projDangerPath: '' }
    const SUPPRESS_NM = 5
    const lastIdx = terrainPts.length - 1
    const segs: { safe: boolean; x: number; y: number }[] = terrainPts.map((tp, i) => {
      const alt = projAlts[i]
      const msa = getMsa(tp.distNm)
      const nearEndpoint = tp.distNm < SUPPRESS_NM || (totalNm - tp.distNm) < SUPPRESS_NM
      const belowMsa = msa > 0 && alt < msa && !nearEndpoint && i !== 0 && i !== lastIdx
      return { safe: !belowMsa, x: xOf(tp.distNm), y: yOf(alt) }
    })
    const buildPath = (wantSafe: boolean) => {
      const parts: string[] = []
      let cur: string[] = []
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i]
        const include = s.safe === wantSafe ||
          (i > 0 && segs[i - 1].safe !== segs[i].safe)  // include transition point
        if (include) {
          cur.push(`${s.x.toFixed(1)},${s.y.toFixed(1)}`)
        } else if (cur.length > 0) {
          parts.push(`M${cur.join(' L')}`)
          cur = []
        }
      }
      if (cur.length > 0) parts.push(`M${cur.join(' L')}`)
      return parts.join(' ')
    }
    return { projSafePath: buildPath(true), projDangerPath: buildPath(false) }
  }, [projAlts, terrainPts, getMsa, totalNm, xOf, yOf])

  // Trajectory ticks ahead of current position — near ticks fixed at 1/3,
  // far tick uses trajectoryNm (mirrors AviationMap's on-map trajectory line
  // so map and chart always agree on where the far tick lands).
  const trajectoryTickNms = useMemo((): number[] => {
    if (currentDistNm == null || (currentSpeedKts ?? 0) < 5 || totalNm === 0) return []
    const marks = trajectoryMode === 'time'
      ? [1, 3, trajectoryNm].map(min => currentDistNm + (min / 60) * currentSpeedKts!)
      : [1, 3, trajectoryNm].map(nm  => currentDistNm + nm)
    return marks.filter(d => d <= totalNm)
  }, [currentDistNm, currentSpeedKts, trajectoryMode, trajectoryNm, totalNm])
  const trajectoryTickLabels = trajectoryMode === 'time'
    ? ['1m', '3m', `${trajectoryNm}m`]
    : ['1nm', '3nm', `${trajectoryNm}nm`]

  // Aircraft pitch tilt — nose up on climb, nose down on descent (visual flourish)
  const pitchDeg = useMemo(() => {
    if (currentVSpeedFpm == null) return 0
    return Math.max(-20, Math.min(20, currentVSpeedFpm / 100))
  }, [currentVSpeedFpm])

  const onChartLayout = useCallback((e: LayoutChangeEvent) => {
    setChartW(e.nativeEvent.layout.width)
  }, [])

  if (!profile || profile.totalNm === 0) return null

  const yTicks = niceYTicks(yMax)
  const xTickCount = 6
  const xTicks = Array.from({ length: xTickCount + 1 }, (_, i) => (totalNm / xTickCount) * i)

  return (
    <View style={[styles.panel, collapsed && styles.panelCollapsed]}>
      {/* Drag handle + header merged into one compact row — title text and
          the separate header row were removed entirely to reclaim vertical
          space (distance is already visible via the X-axis; mode context
          [planned/look-ahead] wasn't worth a dedicated text row). The grip
          is absolutely centred so the PROJ toggle can sit at the right edge
          of the same row without fighting it for layout space. */}
      <View style={styles.dragHandle} {...panResponder.panHandlers}>
        <View style={styles.dragGrip} />
        {perf && (
          <TouchableOpacity
            style={[styles.projBtn, showProjection && styles.projBtnOn]}
            onPress={() => setShowProjection(v => !v)}
          >
            <Text style={[styles.projBtnTxt, showProjection && styles.projBtnTxtOn]}>PROJ</Text>
          </TouchableOpacity>
        )}
      </View>
      {/* ── Chart ──────────────────────────────────────────────────── */}
      {!collapsed && (
        <View style={[styles.chartWrap, { height: chartH }]} onLayout={onChartLayout} {...scrubResponder.panHandlers}>
          {chartW > 0 && (
            <>
              <Svg width={chartW} height={chartH}>
                <Defs>
                  <LinearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
                    <Stop offset="0%"  stopColor="#0d1424" stopOpacity={1} />
                    <Stop offset="70%" stopColor="#141b30" stopOpacity={1} />
                    <Stop offset="100%" stopColor="#1a2338" stopOpacity={1} />
                  </LinearGradient>
                  <LinearGradient id="terrainGrad" x1="0" y1="0" x2="0" y2="1">
                    <Stop offset="0%"   stopColor="#55524e" stopOpacity={0.85} />
                    <Stop offset="35%"  stopColor="#6c5434" stopOpacity={0.78} />
                    <Stop offset="60%"  stopColor="#52642e" stopOpacity={0.70} />
                    <Stop offset="82%"  stopColor="#345c34" stopOpacity={0.65} />
                    <Stop offset="93%"  stopColor="#26552a" stopOpacity={0.62} />
                    <Stop offset="100%" stopColor="#1e508c" stopOpacity={0.68} />
                  </LinearGradient>
                </Defs>

                {/* Sky background */}
                <Path d={`M0,0 L${chartW},0 L${chartW},${chartH} L0,${chartH} Z`} fill="url(#sky)" />

                {/* Y-axis grid lines */}
                {yTicks.map((ft, i) => (
                  <SvgLine key={`yg-${i}`} x1={MARGIN_L} y1={yOf(ft)} x2={chartW - MARGIN_R} y2={yOf(ft)}
                    stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
                ))}

                {/* ── Airspace bands (glow halo + fill + border + chip) ── */}
                {profile.airspaceBands.map((band, i) => {
                  const x1 = xOf(band.entryNm), x2 = xOf(band.exitNm)
                  const yTop = yOf(band.upper_ft), yBot = yOf(band.lower_ft)
                  const d = `M${x1},${yTop} L${x2},${yTop} L${x2},${yBot} L${x1},${yBot} Z`
                  return (
                    <G key={`band-${i}`}>
                      <Path d={d} fill={band.fill} />
                      {/* Glow halo — wide low-opacity stroke behind the crisp border */}
                      <Path d={d} fill="none" stroke={band.border} strokeOpacity={0.25} strokeWidth={5} />
                      <Path d={d} fill="none" stroke={band.border} strokeWidth={1.25} />
                    </G>
                  )
                })}

                {/* ── Terrain relief shadow + fill + outline ─────────── */}
                {profile.waterCrossings.map((wc, i) => {
                  const spanElevs = terrainPts
                    .filter(p => p.distNm >= wc.entryNm && p.distNm <= wc.exitNm)
                    .map(p => p.elevFt)
                  const spanMaxFt = Math.max(200, ...(spanElevs.length ? spanElevs : [0]))
                  const x1 = xOf(wc.entryNm), x2 = xOf(wc.exitNm)
                  const yTop = yOf(spanMaxFt), yBot = yOf(0)
                  const d = `M${x1},${yTop} L${x2},${yTop} L${x2},${yBot} L${x1},${yBot} Z`
                  return <Path key={`water-${i}`} d={d} fill="rgba(30,100,200,0.35)" stroke="rgba(60,140,230,0.7)" strokeWidth={1} />
                })}

                <Path d={terrainPath.shadow} fill="rgba(0,0,0,0.28)" />
                <Path d={terrainPath.fill} fill="url(#terrainGrad)" />
                <Path d={terrainPath.outline} fill="none" stroke="rgba(160,130,90,0.55)" strokeWidth={1} />

                {/* ── MSA dashed line ─────────────────────────────────── */}
                {msaPath && (
                  <Path d={msaPath} fill="none" stroke="rgba(251,146,60,0.65)" strokeWidth={1} strokeDasharray="5,3" />
                )}

                {/* ── Planned altitude step-line ──────────────────────── */}
                <Path
                  d={plannedPath}
                  fill="none"
                  stroke={showProjection && perf ? 'transparent' : theme.accentMagenta}
                  strokeWidth={2}
                />

                {/* ── Projected flight path (PROJ toggle) ─────────────── */}
                {showProjection && perf && projSafePath && (
                  <Path d={projSafePath} fill="none" stroke="rgba(0,220,255,0.90)" strokeWidth={2} />
                )}
                {showProjection && perf && projDangerPath && (
                  <Path d={projDangerPath} fill="none" stroke="rgba(239,68,68,0.95)" strokeWidth={2.5} />
                )}

                {/* ── Waypoint ticks ──────────────────────────────────── */}
                {profile.waypointTicks.map((tick, i) => i === 0 ? null : (
                  <SvgLine key={`wp-${i}`} x1={xOf(tick.distNm)} y1={MARGIN_T} x2={xOf(tick.distNm)} y2={MARGIN_T + plotH}
                    stroke="rgba(255,255,255,0.16)" strokeWidth={1} />
                ))}

                {/* ── Trajectory ticks ─────────────────────────────────── */}
                {trajectoryTickNms.map((d, i) => (
                  <SvgLine key={`traj-${i}`} x1={xOf(d)} y1={MARGIN_T} x2={xOf(d)} y2={MARGIN_T + plotH}
                    stroke="rgba(250,204,21,0.70)" strokeWidth={1} strokeDasharray="3,3" />
                ))}

                {/* ── Scrub crosshair (touch-drag on the chart) ───── */}
                {hoverNm != null && (
                  <SvgLine x1={xOf(hoverNm)} y1={MARGIN_T} x2={xOf(hoverNm)} y2={MARGIN_T + plotH}
                    stroke="rgba(250,204,21,0.85)" strokeWidth={1.5} strokeDasharray="4,3" />
                )}

                {/* ── Live position marker + aircraft silhouette ──────── */}
                {currentDistNm != null && (
                  <SvgLine x1={xOf(currentDistNm)} y1={MARGIN_T} x2={xOf(currentDistNm)} y2={MARGIN_T + plotH}
                    stroke="rgba(255,255,255,0.40)" strokeWidth={1} strokeDasharray="3,3" />
                )}
                {currentDistNm != null && currentAltFt != null && (
                  <G transform={`translate(${xOf(currentDistNm)}, ${yOf(currentAltFt)}) rotate(${-pitchDeg})`}>
                    <Circle r={9} fill="rgba(34,197,94,0.18)" />
                    <Path d="M12,0 C8,-2 0,-2.5 -8,-1.5 L-12,-0.5 L-12,1 L-8,2 C0,2.5 8,2 12,0Z" fill="#ffffff" fillOpacity={0.97} />
                    <Path d="M0,2 L5,2 L9,10 L7,10Z" fill="#ffffff" fillOpacity={0.95} />
                    <Path d="M-10,-1.5 L-8,-1.5 L-7,-7 L-9,-7 L-12,-0.5Z" fill="#ffffff" fillOpacity={0.9} />
                    <Path d="M-12,0.5 L-9,1.5 L-8,5 L-10,5Z" fill="#ffffff" fillOpacity={0.85} />
                  </G>
                )}

                {/* ── X-axis distance ticks ────────────────────────────── */}
                {xTicks.map((d, i) => (
                  <SvgLine key={`xt-${i}`} x1={xOf(d)} y1={MARGIN_T + plotH} x2={xOf(d)} y2={MARGIN_T + plotH + 3}
                    stroke="rgba(255,255,255,0.25)" strokeWidth={1} />
                ))}
              </Svg>

              {/* ── Overlay: obstacle icons, waypoint/axis text (RN Text for crispness) ──
                  Airspace band class/ceiling chips removed for now — no dedup
                  against stacked sub-sectors sharing an identical ceiling (e.g.
                  multiple TMA sub-sectors all topping at FL095 but with
                  different floors) produced repeated, uninformative "TMA
                  FL095" chips scrolling past as the live look-ahead window
                  moved. Y-position + band colour already encode
                  altitude/class; revisit with a floor–ceiling format + dedup
                  instead of re-adding as-is. */}
              <View style={StyleSheet.absoluteFill} pointerEvents="none">
                {profile.obstacles.map((obs, i) => {
                  const baseFt = Math.max(obs.elevationFt, terrainAt(terrainPts, obs.distNm))
                  const tipFt  = obs.heightM > 0 ? Math.round(baseFt + obs.heightM * 3.28084) : baseFt
                  const icon = OBSTACLE_ICONS[obs.kind] ?? OBSTACLE_ICON_FALLBACK
                  const size = 16
                  return (
                    <Image
                      key={`obs-${i}`}
                      source={icon}
                      style={{ position: 'absolute', width: size, height: size, left: xOf(obs.distNm) - size / 2, top: yOf(tipFt) - size / 2 }}
                      resizeMode="contain"
                    />
                  )
                })}

                {profile.landmarks.map((lmk, i) => {
                  const baseFt = terrainAt(terrainPts, lmk.distNm)
                  const icon = LANDMARK_ICONS[lmk.kind] ?? LANDMARK_ICON_FALLBACK
                  const size = 14
                  return (
                    <Image
                      key={`lmk-${i}`}
                      source={icon}
                      style={{ position: 'absolute', width: size, height: size, left: xOf(lmk.distNm) - size / 2, top: yOf(baseFt) - size / 2 }}
                      resizeMode="contain"
                    />
                  )
                })}

                {profile.waypointTicks.map((tick, i) => i === 0 ? null : (
                  // Clamp so the destination's label (sitting exactly at the
                  // right edge of the plot) doesn't overflow past chartW and
                  // get clipped to just its first letter.
                  <Text
                    key={`wpl-${i}`}
                    style={[styles.wpLabel, { left: Math.min(chartW - 44, xOf(tick.distNm) + 2), top: MARGIN_T }]}
                    numberOfLines={1}
                  >
                    {tick.name}
                  </Text>
                ))}

                {trajectoryTickNms.map((d, i) => (
                  <Text key={`trajl-${i}`} style={[styles.trajLabel, { left: xOf(d) - 8, top: MARGIN_T - 10 }]}>
                    {trajectoryTickLabels[i]}
                  </Text>
                ))}

                {yTicks.map((ft, i) => (
                  <Text key={`yl-${i}`} style={[styles.axisLabel, { left: 2, top: yOf(ft) - 6 }]}>
                    {ft >= 1000 ? `FL${Math.round(ft / 100).toString().padStart(3, '0')}` : `${ft}`}
                  </Text>
                ))}

                {xTicks.map((d, i) => (
                  <Text key={`xl-${i}`} style={[
                    styles.axisLabelX,
                    { left: Math.min(chartW - 20, Math.max(0, xOf(d) - 8)), top: MARGIN_T + plotH + 4 },
                  ]}>
                    {nmToDisplay(d, units.distance).toFixed(0)}
                  </Text>
                ))}
              </View>
            </>
          )}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: theme.surfacePanel,
    borderTopWidth:  1,
    borderColor:     theme.borderDefault,
  },
  panelCollapsed: {},
  dragHandle: {
    height:          22,
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'center',
    backgroundColor: theme.surfaceOverlay,
  },
  dragGrip: {
    width:           48,
    height:          5,
    borderRadius:    3,
    backgroundColor: theme.textMuted,
  },
  projBtn: {
    position:          'absolute',
    right:             theme.space2,
    borderWidth:       1,
    borderColor:       theme.borderDefault,
    borderRadius:      theme.radiusSm,
    paddingHorizontal: theme.space2,
    paddingVertical:   2,
  },
  projBtnOn: {
    backgroundColor: 'rgba(0,220,255,0.15)',
    borderColor:     'rgba(0,220,255,0.6)',
  },
  projBtnTxt: {
    color:      theme.textMuted,
    fontSize:   9,
    fontWeight: '700',
  },
  projBtnTxtOn: { color: '#00dcff' },
  chartWrap: {},
  wpLabel: {
    position: 'absolute',
    color:    'rgba(255,255,255,0.55)',
    fontSize: 8,
    maxWidth: 60,
  },
  trajLabel: {
    position: 'absolute',
    color:    'rgba(250,204,21,0.90)',
    fontSize: 8,
    fontWeight: '600',
  },
  axisLabel: {
    position: 'absolute',
    color:    'rgba(255,255,255,0.45)',
    fontSize: 8,
  },
  axisLabelX: {
    position: 'absolute',
    color:    'rgba(255,255,255,0.45)',
    fontSize: 8,
  },
})
