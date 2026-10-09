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
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler'
import Animated, { useSharedValue, useAnimatedStyle, withDecay, cancelAnimation } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import Svg, { ClipPath, Rect, Path, Line as SvgLine, Circle, Defs, LinearGradient, Stop, G, Text as SvgText } from 'react-native-svg'

import type { RouteWaypoint, LegOverride, AircraftProfileDocType } from '../types/db'
import { type Units, DEFAULT_UNITS, nmToDisplay } from '../utils/units'
import {
  buildVirtualRadarProfile,
  applyTerrainToBands,
  fetchTerrainProfile,
  projectFlightPath, plannedAltitudeLine,
  computeMsaProfile,
  terrainAt,
  getMsaLookup,
  computeTrajectoryTicks,
  computeVspeedTrajectory,
  projectWeatherMarks,
  type TerrainPoint,
  type MsaPoint,
  type AircraftPerfModel,
} from '@open-vfr/shared/virtualRadarCalc'
import { getAircraftSilhouette } from '@open-vfr/shared/aircraftSilhouette'
import { airspaceOutlines, airspaceChips, layoutAirspaceChips } from '@open-vfr/shared/airspaceOutline'
import {
  cloudLayerPaths, cloudLayerLabel, cloudGlyphHeight, cloudOpacityForOffset, cloudReportOffRouteNm,
  cloudReportIcao, cloudStripHalfWidthNm, placeCloudLabel, type LabelRect,
} from '@open-vfr/shared/cloudGlyph'
import { CLOUD_COLORS } from '@open-vfr/shared/featureColors'
import { resolveStationWeather } from '@open-vfr/shared/parseTaf'
import { windBarbColorForSpeed, windBarbGeometry } from '@open-vfr/shared/windBarb'
import { layoutWindRow, type WindRowItem } from '@open-vfr/shared/windRow'
import { useWindAloftAlongRoute } from '../hooks/useWindAloftAlongRoute'
import { getTileUrls, API_BASE } from '../config'
import { getOfflineDem } from '../utils/terrainDem'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import type { RouteWeatherStation } from '../hooks/useWeatherAlongRoute'

// ---------------------------------------------------------------------------
// Module-level GeoJSON cache — fetch + JSON.parse each of these exactly once
// per app lifetime, not once per VerticalProfile *mount*.
//
// Without this, every fresh mount (ruler mode turned on, route planned,
// look-ahead engaged after a route is cleared, etc. — each is a distinct
// branch in MapScreen's render ternary, so switching between them unmounts
// and remounts this component) re-fetched and re-JSON.parsed all the files
// (airspace, obstacles, landmarks) from scratch. `JSON.parse` of a
// several-hundred-KB-to-multi-MB payload runs synchronously on the JS
// thread — with 4 of them in flight together, this stalled the JS thread
// for several seconds, during which every touchable on screen (map controls,
// sheets, etc.) silently ate taps while MapLibre's own native pan/zoom kept
// working fine (it doesn't depend on the JS thread), making the app look
// frozen right after e.g. placing the ruler's second point. Mirrors the
// same load-once module cache pattern already used by
// usePositionAlerts.ts (combined airspace/obstruction/airfield/notification hook).
// ---------------------------------------------------------------------------
const _geoJsonCache = new Map<string, Promise<GeoJSON.FeatureCollection>>()
function loadGeoJsonOnce(url: string): Promise<GeoJSON.FeatureCollection> {
  let p = _geoJsonCache.get(url)
  if (!p) {
    p = fetch(url).then(r => r.json())
    p.catch(() => { _geoJsonCache.delete(url) })   // allow retry on next mount if it failed
    _geoJsonCache.set(url, p)
  }
  return p
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  waypoints:    RouteWaypoint[]
  legOverrides: LegOverride[]
  units?:       Units
  /** Same ceiling filter as the map's airspace layers (settings.airspaceCeilingFt)
   *  -- airspace bands whose floor is above this are hidden from the chart,
   *  matching what's already hidden on the map. Unfiltered if omitted. */
  airspaceCeilingFt?: number
  title?: string
  /** Optional content for the drag-handle row, left / right of the grip
   *  (right slot sits before the PROJ toggle). Lets a caller show a compact
   *  readout (e.g. Map Ruler distance/track) inside the panel's own chrome
   *  instead of as a separate floating overlay. */
  headerStart?: React.ReactNode
  headerEnd?: React.ReactNode
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
  /** Lateral (cross-track) distance in NM between the aircraft and the
   *  planned route line — see routeCrossTrackNm in virtualRadarCalc. When
   *  this exceeds OFF_TRACK_BADGE_NM the chart badges itself: terrain/
   *  airspace/MSA here are only ever sampled along the *planned* corridor,
   *  so once the aircraft has meaningfully diverged, what's drawn ahead of
   *  the "you are here" marker is no longer what's actually ahead of the
   *  aircraft. Omit (or pass undefined) to suppress the badge entirely —
   *  e.g. for the synthesised look-ahead profile, which is built from the
   *  aircraft's own current track and therefore can't be "off" itself. */
  crossTrackNm?: number
  /** METAR/TAF stations along the route (from useWeatherAlongRoute) — wind
   *  arrows and cloud-base layers are drawn at each station's projected
   *  along-route position. Omit to hide entirely. */
  weatherStations?: RouteWeatherStation[]
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

// DEFAULT_CHART_H = MARGIN_T + a plot of the same height as before + MARGIN_B
// (the wind row lives in the bottom margin, under the x axis).
export const DEFAULT_CHART_H  = 218
export const MIN_CHART_H      = 0
export const MAX_CHART_H      = 340
export const COLLAPSE_THRESHOLD = 24   // below this, treat as "collapsed"
const MARGIN_L  = 34   // room for FL/alt ticks
const MARGIN_R  = 10
const MARGIN_T  = 26
const MARGIN_B  = 30   // tick labels + the wind-barb row under the x axis
/** Top of the pinned Y-axis column's opaque backing: just above the top
 *  tick label (drawn at yOf(yMax) - 6 = MARGIN_T - 6). */
const AXIS_COVER_TOP = MARGIN_T - 8
// Wind row: one row of barbs just under the x axis, in the same band as the
// tick labels (METAR/TAF station barbs + ground-model barbs; see
// @open-vfr/shared/windRow for the placement rule). Offset is from the axis.
const WIND_ROW_DY = 14
const WIND_ROW_FONT = 10
const WIND_ROW_EDGE_L_PX = 16   // clears the "0" tick label
const WIND_ROW_EDGE_R_PX = 12
const WIND_ROW_STATION_SEP_NM = 6

// Never compress a long route down to fit the panel width —
// below this pixel-per-NM density the chart becomes horizontally scrollable
// instead of squeezing the whole route in, so short legs stay legible. Only
// kicks in once totalNm * MIN_PX_PER_NM exceeds the panel's actual width.
// Bumped 18->30 -- mirrors web's identical fix (see VirtualRadar.tsx):
// at 18, almost any panel width fits a 40-50nm route without ever needing
// to scroll, so the scroll path effectively never activated for realistic
// route lengths even though labels were visibly cramped well before that.
const MIN_PX_PER_NM = 30
/** Minimum gap (ms) between scrub-position reports to the parent (map
 *  crosshair): each report re-renders the map screen on the JS thread. */
const HOVER_REPORT_MS = 100
// Wind arrow/label horizontal clamp margin (px) from either plot edge —
// mirrors web's VirtualRadar.tsx identical fix. Without it, a station near
// the route's start/end lands the arrow (and its dirDeg/speed label) right
// on top of the y-axis/plot edge instead of just inside it.
const WIND_EDGE_MARGIN_PX = 22
// Cross-track deviation beyond which the chart badges itself as showing a
// route the aircraft is no longer actually on (see crossTrackNm prop doc).
const OFF_TRACK_BADGE_NM = 3

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


// Shared size for BOTH the real-station and wind-sample barbs -- mirrors
// web's identical VirtualRadar.tsx constants. They used to differ (real
// bigger/bolder, sample smaller/dimmed) to visually flag "observed vs.
// estimated", but that read as one being broken/lower-quality rather than
// intentional. The "~" text prefix is already the differentiator.
const WIND_BARB_SHAFT_LEN = 18
const WIND_BARB_BARB_LEN  = 8
const WIND_BARB_HALF_LEN  = 5
const WIND_BARB_BARB_GAP  = 5
const WIND_BARB_STROKE_W  = 1.8

/**
 * Renders a small WMO-style wind barb (shaft + pennant/full/half-barb
 * feathers) at the origin, mirroring web's VirtualRadar.tsx identical
 * helper -- see @open-vfr/shared/windBarb's windBarbGeometry for the
 * shared geometry/reading convention. Replaces a plain arrow+triangle-
 * head that only encoded speed via colour/thickness, found during a
 * pre-release pass to be too subtle to read strength from at a glance.
 * Draws a dark outline pass underneath the coloured pass first, same
 * contrast fix as the map's wind-barb icons.
 */
function renderWindBarbShape(
  speedKts: number,
  color: string,
  opts: { strokeW?: number; shaftLen?: number; barbLen?: number; halfLen?: number; barbGap?: number; outlineOpacity?: number } = {},
) {
  const { shaft, feathers } = windBarbGeometry(speedKts, opts)
  if (!shaft) return null
  const strokeW = opts.strokeW ?? 1.6
  const outlineColor = `rgba(0,0,0,${opts.outlineOpacity ?? 0.65})`
  const outlineW = strokeW + 1.2

  const renderPass = (stroke: string, fill: string, width: number, key: string) => (
    <G key={key}>
      <SvgLine x1={shaft.x1} y1={shaft.y1} x2={shaft.x2} y2={shaft.y2} stroke={stroke} strokeWidth={width} strokeLinecap="round" />
      {feathers.map((f, idx) =>
        f.kind === 'line' ? (
          <SvgLine key={idx} x1={f.x1} y1={f.y1} x2={f.x2} y2={f.y2} stroke={stroke} strokeWidth={width} strokeLinecap="round" />
        ) : (
          <Path
            key={idx}
            d={`M${f.points[0][0]},${f.points[0][1]} L${f.points[1][0]},${f.points[1][1]} L${f.points[2][0]},${f.points[2][1]} Z`}
            fill={fill}
          />
        ),
      )}
    </G>
  )

  return (
    <>
      {renderPass(outlineColor, outlineColor, outlineW, 'outline')}
      {renderPass(color, color, strokeW, 'main')}
    </>
  )
}

/**
 * Renders SVG text with a dark outline halo -- two stacked <Text>s (a
 * stroke-only pass underneath, a fill-only pass on top) rather than a
 * single Text with `paintOrder="stroke"`, since paint-order support isn't
 * guaranteed across react-native-svg's Android/iOS backends the way it is
 * in real browser SVG (used directly in web's identical VirtualRadar.tsx
 * fix). Mirrors the map barb icons' own double-pass contrast technique.
 * Restored after an earlier pass removed these chart labels entirely --
 * the barb shape alone was judged sufficient, but the actual complaint was
 * illegibility, not wanting the number gone, so this fixes contrast
 * instead of removing the label.
 */
function renderHaloText(x: number, y: number, text: string, fill: string, fontSize: number, opacity = 1, anchor: 'start' | 'middle' | 'end' = 'start') {
  return (
    <G key={`${x}-${y}-${text}`} opacity={opacity}>
      <SvgText x={x} y={y} fontSize={fontSize} textAnchor={anchor} fill="none" stroke="rgba(0,0,0,0.75)" strokeWidth={3} strokeLinejoin="round">{text}</SvgText>
      <SvgText x={x} y={y} fontSize={fontSize} textAnchor={anchor} fill={fill}>{text}</SvgText>
    </G>
  )
}

/**
 * Picks right-of-arrow or left-of-arrow placement for a wind label,
 * flipping to the left when the route's final station sits close enough
 * to the chart's right edge that a right-side label would run past it and
 * get clipped by the chart's own width -- a station right at the route's
 * end could otherwise render a right-side label that looked like it
 * should fit, yet still got visually cut off, dropping its "/NNkt" suffix
 * (caught in a device review). Mirrors web's identical VirtualRadar.tsx
 * fix. Returns null only if NEITHER side has room, which should be rare
 * at this chart's minimum width.
 */
function windLabelPlacement(cx: number, halfW: number, text: string, fontSize: number, rightBound: number, leftBound: number): { x: number; anchor: 'start' | 'end' } | null {
  const labelW = text.length * fontSize * 0.62
  const rightX = cx + halfW + 4
  if (rightX + labelW <= rightBound) return { x: rightX, anchor: 'start' }
  const leftX = cx - halfW - 4
  if (leftX - labelW >= leftBound) return { x: leftX, anchor: 'end' }
  return null
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VerticalProfile({
  waypoints, legOverrides, units = DEFAULT_UNITS, airspaceCeilingFt, title, headerStart, headerEnd, aircraftProfile,
  currentDistNm, currentAltFt, currentSpeedKts, currentVSpeedFpm, trajectoryMode, trajectoryNm = 5,
  crossTrackNm, weatherStations,
  height = DEFAULT_CHART_H, onHeightChange, onHoverDistNm,
}: Props) {
  const styles = useThemedStyles(makeStyles)
  const [airspaceGeo, setAirspaceGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [obstacleGeo, setObstacleGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [landmarkGeo, setLandmarkGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [terrainPts, setTerrainPts]   = useState<TerrainPoint[]>([])
  // True when neither the elevation API nor the offline DEM could supply
  // terrain for this route: the chart then has no ground, MSA or AGL lift.
  const [terrainFailed, setTerrainFailed] = useState(false)
  const [msaPts,     setMsaPts]       = useState<MsaPoint[]>([])
  const [showProjection, setShowProjection] = useState(false)
  const [showWindAloft, setShowWindAloft] = useState(true)
  const [chartW,      setChartW]      = useState(0)
  // Horizontal scroll offset into the (possibly wider-than-panel) chart
  // content — see MIN_PX_PER_NM above. 0 when the route fits the panel.
  // Horizontal scroll offset (px) and scrub-crosshair position (viewport px,
  // -1 = hidden) live in Reanimated shared values, not React state: the drag
  // runs on the UI thread and moves the content without re-rendering the
  // chart. Re-rendering the whole SVG on every touch-move held the JS thread
  // at ~3 fps during a drag. scrollXRef mirrors scrollX for JS-side logic
  // (auto-follow), synced when a gesture or fling ends.
  const scrollX = useSharedValue(0)
  const hoverX  = useSharedValue(-1)
  const scrollXRef = useRef(0)
  const setScroll = useCallback((x: number) => {
    scrollXRef.current = x
    cancelAnimation(scrollX)
    scrollX.value = x
  }, [scrollX])

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
    // Only claim a touch that began on a header button (ruler clear, PROJ)
    // once it has really moved vertically: claiming on any move turned a
    // tap with slight finger jitter into a zero-height resize and cancelled
    // the button press.
    onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dy) > 6,
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

  // Load GeoJSON once per app lifetime (module-level cache above) — cheap on
  // every mount after the first, since repeat calls just resolve an
  // already-settled promise instead of re-fetching/re-parsing.
  // Deliberately NOT loading se-water.geojson here (the lake/reservoir
  // crossings overlay). It is ~24 MB -- every lake and reservoir in Sweden
  // -- and React Native's Android fetch() cannot handle a response that
  // size: the body is held in the Java heap as raw bytes, then as a UTF-16
  // string (~48 MB), then streamed to JS in JSON-encoded chunks, with every
  // intermediate copy alive at once. Measured live on a Galaxy S23 Ultra:
  // the Java heap climbed from ~30 MB to the 512 MB largeHeap ceiling in
  // ~16 s of constant GC churn and threw OutOfMemoryError on the OkHttp
  // thread, the moment a route was planned (this component's mount). The
  // other three files are 0.5-3 MB and fine. buildVirtualRadarProfile
  // accepts water as undefined, so the chart just omits lake crossings. See
  // AGENTS.md ("Large GeoJSON must never go through fetch() on native").
  useEffect(() => {
    loadGeoJsonOnce(getTileUrls().airspace).then(setAirspaceGeo).catch(() => {})
    loadGeoJsonOnce(getTileUrls().obstacles).then(setObstacleGeo).catch(() => {})
    loadGeoJsonOnce(getTileUrls().landmarks).then(setLandmarkGeo).catch(() => { /* optional layer — offline-safe no-op */ })
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
    setTerrainFailed(false)
    // API_BASE, not TILE_BASE -- /api/elevation/ is proxied by the api
    // server's nginx, a different host from TILE_BASE (which in production
    // points at the object-storage tile bucket domain). Using
    // TILE_BASE here hit the R2 bucket with a bogus path and came back with
    // a 401 misreported as "OpenTopoData HTTP 401" (found 2026-09-20).
    // Offline: the cached hillshade DEM stands in for the elevation API.
    fetchTerrainProfile(waypoints, API_BASE, controller.signal, getOfflineDem())
      .then((pts) => {
        setTerrainPts(pts)
        setMsaPts(computeMsaProfile(pts))
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') {
          console.warn('[VerticalProfile] terrain fetch failed:', err)
          setTerrainFailed(true)
        }
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey])

  const rawProfile = useMemo(() => {
    if (waypoints.length < 2 || !airspaceGeo || !obstacleGeo) return null
    // water: undefined on native -- see the loader comment above.
    return buildVirtualRadarProfile(waypoints, legOverrides, airspaceGeo, obstacleGeo, undefined, landmarkGeo ?? undefined, airspaceCeilingFt ?? Infinity, aircraftProfile?.cruiseAltFt || undefined)
  }, [waypoints, legOverrides, airspaceGeo, obstacleGeo, landmarkGeo, airspaceCeilingFt, aircraftProfile?.cruiseAltFt])
  // AGL limits are published as heights: lift them onto the terrain along the
  // crossing once the terrain profile is in, so bands draw at their real altitude.
  const profile = useMemo(
    () => rawProfile && { ...rawProfile, airspaceBands: applyTerrainToBands(rawProfile.airspaceBands, terrainPts) },
    [rawProfile, terrainPts],
  )

  // Shared with web's VirtualRadar.tsx (getMsaLookup) — this used to be a
  // byte-for-byte duplicate independently maintained in both files.
  const getMsa = useMemo(() => getMsaLookup(msaPts), [msaPts])

  const yMax = useMemo(() => {
    if (!profile) return 10000
    const planned    = Math.max(profile.maxPlannedAltFt, 1000)
    const maxTerrain = terrainPts.reduce((m, p) => Math.max(m, p.elevFt), 0)
    const raw        = Math.max(planned * 1.5, maxTerrain * 1.2, 3000)
    return Math.ceil(raw / 1000) * 1000
  }, [profile, terrainPts])

  const totalNm = profile?.totalNm ?? 0
  // Winds aloft at the standard levels up to the chart top, one column every ~20 NM.
  const windAloft = useWindAloftAlongRoute(waypoints, totalNm, yMax, showWindAloft)
  // Content (not panel) plot width: never below what the panel offers, but
  // grows past it once the route needs more than MIN_PX_PER_NM per NM to
  // stay legible (see MIN_PX_PER_NM comment above). contentW
  // is what actually gets drawn into the Svg; chartW is just the visible
  // clipping window.
  const availablePlotW = Math.max(0, chartW - MARGIN_L - MARGIN_R)
  const desiredPlotW   = totalNm * MIN_PX_PER_NM
  const plotW    = Math.max(availablePlotW, desiredPlotW)
  const plotH    = chartH - MARGIN_T - MARGIN_B
  const contentW = plotW + MARGIN_L + MARGIN_R
  const scrollable = contentW > chartW + 0.5
  const maxScrollX  = Math.max(0, contentW - chartW)

  const xOf = useCallback((distNm: number) => MARGIN_L + (totalNm > 0 ? (distNm / totalNm) * plotW : 0), [totalNm, plotW])
  const yOf = useCallback((altFt: number) => MARGIN_T + plotH - (yMax > 0 ? (altFt / yMax) * plotH : 0), [yMax, plotH])
  // Clamped x for wind arrows/labels only -- keeps the marker inside the
  // plot area by WIND_EDGE_MARGIN_PX regardless of route length, falling
  // back to plotW/2 on a route too short for the full margin on both sides.
  const windXOf = useCallback((distNm: number) => {
    const margin = Math.min(WIND_EDGE_MARGIN_PX, plotW / 2)
    return Math.min(MARGIN_L + plotW - margin, Math.max(MARGIN_L + margin, xOf(distNm)))
  }, [xOf, plotW])

  // Waypoint-name label collision avoidance -- mirrors web's identical fix.
  // Skip a label if it would land within MIN_WP_LABEL_GAP_PX of the last
  // one actually kept (not just the last one considered), using the real
  // px scale (xOf) directly since native already tracks true pixel
  // positions, unlike web's Recharts-domain approximation.
  const MIN_WP_LABEL_GAP_PX = 46
  const visibleWaypointTicks = useMemo(() => {
    if (!profile) return []
    // Seeded at xOf(0) (the Y-axis's own pixel position), not -Infinity --
    // see web's identical VirtualRadar.tsx fix for why: a second waypoint
    // genuinely very close to departure (e.g. a VRP named after a literal
    // landmark right by the airfield -- "Church", "Tol\u00e5nga kyrka") had
    // nothing before it to collide against, so it always rendered
    // regardless of proximity to x=0, overlapping the Y-axis/FL-scale
    // margin -- reported as the label rendering "outside the chart".
    let lastX = xOf(0)
    const out: typeof profile.waypointTicks = []
    profile.waypointTicks.forEach((tick, i) => {
      if (i === 0) return // departure skipped, same as before -- sits on Y-axis
      const x = xOf(tick.distNm)
      if (x - lastX < MIN_WP_LABEL_GAP_PX) return
      out.push(tick)
      lastX = x
    })
    return out
  }, [profile, xOf])

  // Clamp the scroll offset whenever the scrollable range shrinks (panel
  // resized wider, or a shorter route replaces a longer one).
  const maxScrollXSV = useSharedValue(maxScrollX)
  useEffect(() => {
    maxScrollXSV.value = maxScrollX
    if (scrollXRef.current > maxScrollX) setScroll(maxScrollX)
  }, [maxScrollX, maxScrollXSV, setScroll])

  // Manual-pan grace period -- see the scrub gesture's onFinalize below,
  // which sets this. Without it, the auto-follow effect's drag guard
  // reopens the INSTANT a finger lifts, so this effect re-fires on the
  // very next render and snaps straight back to the aircraft before the
  // pilot ever gets to look at wherever they just panned to -- especially
  // bad off-track, where the aircraft marker can sit right at the route's
  // end, making every pan feel like it does nothing. Web has no equivalent
  // bug: its pan uses real DOM scrollLeft, which release never touches, so
  // nothing re-triggers its version of this effect. currentDistNm updates
  // on every GPS tick during flight, so this effect naturally re-runs and
  // re-checks the grace deadline again soon after it expires -- no separate
  // timer needed to "wake" it back up.
  const MANUAL_PAN_GRACE_MS = 4000
  const manualPanUntilRef = useRef(0)

  // Auto-follow the aircraft while flying: if its marker has scrolled out of
  // (or near) the visible window, re-center the view on it. Skipped while
  // the pilot is mid-drag (draggingRef) or shortly after releasing a
  // manual pan (manualPanUntilRef) so this doesn't fight a pan/scrub either
  // during or immediately after the gesture.
  const draggingRef = useRef(false)
  useEffect(() => {
    if (currentDistNm == null || !scrollable || draggingRef.current) return
    if (Date.now() < manualPanUntilRef.current) return
    const markerX = xOf(currentDistNm)
    const EDGE = 40
    const x = scrollXRef.current
    if (markerX < x + EDGE || markerX > x + chartW - EDGE) {
      setScroll(Math.max(0, Math.min(maxScrollX, markerX - chartW / 2)))
    }
  }, [currentDistNm, scrollable, chartW, maxScrollX, xOf, setScroll])

  // Touch-drag over the chart plot area does double duty:
  //  1. Scrub — a crosshair follows the finger, and the parent screen syncs
  //     a crosshair marker on the map (native equivalent of web's Recharts
  //     onMouseMove/onMouseLeave).
  //  2. Pan — when the route is wider than the panel (MIN_PX_PER_NM,
  //     above), the same one-finger drag scrolls the content, with a fling
  //     (decay) on release. One gesture drives both, so the two forms of
  //     horizontal drag never race two gesture systems.
  // Runs on the UI thread: scroll offset and crosshair are shared values
  // read by animated styles, so dragging never re-renders the chart. The
  // map crosshair is reported to JS at most every HOVER_REPORT_MS.
  const totalNmSV = useSharedValue(totalNm)
  const plotWSV   = useSharedValue(plotW)
  useEffect(() => { totalNmSV.value = totalNm; plotWSV.value = plotW }, [totalNm, plotW, totalNmSV, plotWSV])
  const dragStartX      = useSharedValue(0)
  const lastHoverReport = useSharedValue(0)
  const onHoverDistNmRef = useRef(onHoverDistNm); onHoverDistNmRef.current = onHoverDistNm
  // Latest-wins: each report re-renders the whole map screen (~250 ms in a
  // dev build), longer than the report interval, so passing every report
  // through queued renders up and the map crosshair fell further behind the
  // finger. Keep only the newest value and deliver it on the next frame.
  const pendingHoverRef = useRef<{ nm: number | null } | null>(null)
  const reportHover = useCallback((nm: number | null) => {
    const idle = pendingHoverRef.current == null
    pendingHoverRef.current = { nm }
    if (idle) requestAnimationFrame(() => {
      const v = pendingHoverRef.current
      pendingHoverRef.current = null
      if (v) onHoverDistNmRef.current?.(v.nm)
    })
  }, [])
  const dragStarted   = useCallback(() => { draggingRef.current = true }, [])
  const dragEnded     = useCallback(() => { draggingRef.current = false }, [])
  const scrollSettled = useCallback((x: number, panned: boolean) => {
    scrollXRef.current = x
    if (panned) manualPanUntilRef.current = Date.now() + MANUAL_PAN_GRACE_MS
  }, [])

  const scrub = usePanGesture({
    minDistance: 0,
    onBegin: (e) => {
      'worklet'
      cancelAnimation(scrollX)
      dragStartX.value = scrollX.value
      hoverX.value = e.x
      const tNm = totalNmSV.value, pW = plotWSV.value
      if (tNm > 0 && pW > 0) {
        scheduleOnRN(reportHover, Math.max(0, Math.min(tNm, ((e.x + scrollX.value - MARGIN_L) / pW) * tNm)))
      }
      lastHoverReport.value = Date.now()
      scheduleOnRN(dragStarted)
    },
    onUpdate: (e) => {
      'worklet'
      scrollX.value = Math.max(0, Math.min(maxScrollXSV.value, dragStartX.value - e.translationX))
      hoverX.value = e.x
      const now = Date.now()
      if (now - lastHoverReport.value >= HOVER_REPORT_MS) {
        lastHoverReport.value = now
        const tNm = totalNmSV.value, pW = plotWSV.value
        if (tNm > 0 && pW > 0) {
          scheduleOnRN(reportHover, Math.max(0, Math.min(tNm, ((e.x + scrollX.value - MARGIN_L) / pW) * tNm)))
        }
      }
    },
    onDeactivate: (e) => {
      'worklet'
      // Fling: keep scrolling with the release velocity, slowing to a stop,
      // clamped to the route's ends.
      if (maxScrollXSV.value > 0 && Math.abs(e.velocityX) > 50) {
        const panned = scrollX.value !== dragStartX.value
        scrollX.value = withDecay(
          { velocity: -e.velocityX, clamp: [0, maxScrollXSV.value], deceleration: 0.997 },
          (finished) => { if (finished) scheduleOnRN(scrollSettled, scrollX.value, panned) },
        )
      }
    },
    onFinalize: () => {
      'worklet'
      hoverX.value = -1
      scheduleOnRN(reportHover, null)
      scheduleOnRN(scrollSettled, scrollX.value, scrollX.value !== dragStartX.value)
      scheduleOnRN(dragEnded)
    },
  })
  const contentStyle = useAnimatedStyle(() => ({ transform: [{ translateX: -scrollX.value }] }))
  const crosshairStyle = useAnimatedStyle(() => ({
    opacity: hoverX.value < 0 ? 0 : 1,
    transform: [{ translateX: Math.max(0, hoverX.value) }],
  }))

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
  // Starts at departure elevation, ramps linearly to the first leg's planned
  // altitude, and ramps down to arrival elevation at the destination.
  const plannedPath = useMemo(() => {
    if (!profile || profile.altitudeProfile.length === 0) return ''
    const line = plannedAltitudeLine(profile.altitudeProfile, profile.totalNm, perf, depElevFt, arrElevFt)
    return `M${line.map(p => `${xOf(p.distNm).toFixed(1)},${yOf(p.altFt).toFixed(1)}`).join(' L')}`
  }, [profile, perf, depElevFt, arrElevFt, xOf, yOf])

  // Weather stations projected onto the route's distance axis — wind
  // arrows + cloud-base layers drawn directly in the vertical profile, not
  // just listed in the separate WeatherAlongRouteSheet. Shared
  // with web's VirtualRadar.tsx (projectWeatherMarks handles the along-route
  // projection + [0,totalNm] filtering; only the METAR string parsing and
  // xOf/yOf pixel mapping stay local to each platform's renderer).
  // TAF only fills in wind/clouds when a station has no current METAR (see
  // resolveStationWeather / parseTaf.ts header for the full scope note —
  // this is NOT a route-position-vs-forecast-time overlay, that needs an
  // ETD field this app doesn't have).
  const weatherMarks = useMemo(() => {
    if (!weatherStations) return []
    return projectWeatherMarks(waypoints, weatherStations, totalNm).map((m) => {
      const resolved = resolveStationWeather({
        metarWind: m.station.decoded?.wind ?? null,
        metarClouds: m.station.decoded?.clouds ?? null,
        taf: m.station.taf,
      })
      return { station: m.station, distNm: m.distNm, offRouteNm: m.offRouteNm, wind: resolved.wind, clouds: resolved.clouds }
    })
  }, [weatherStations, waypoints, totalNm])

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
  // so map and chart always agree on where the far tick lands). Shared with
  // web's VirtualRadar.tsx (computeTrajectoryTicks); web's own trajectoryMode
  // uses 'time'|'dist' naming, native uses 'time'|'nm' — both translate to
  // the shared function's timeMode boolean rather than either renaming its
  // own prop.
  const trajectoryTicks = useMemo(() => computeTrajectoryTicks({
    currentDistNm, currentSpeedKts, timeMode: trajectoryMode === 'time',
    marks: [1, 3, trajectoryNm], totalNm,
  }), [currentDistNm, currentSpeedKts, trajectoryMode, trajectoryNm, totalNm])
  const trajectoryTickNms = useMemo(() => trajectoryTicks.map((t) => t.distNm), [trajectoryTicks])
  const trajectoryTickLabels = trajectoryMode === 'time'
    ? ['1m', '3m', `${trajectoryNm}m`]
    : ['1nm', '3nm', `${trajectoryNm}nm`]

  // Vertical-speed-aware trajectory line — dots at 2, 5 and 10 minutes
  // ahead show a climb/descent/level attitude visually, not just distance
  // markers. Domain math (constant-
  // rate extrapolation + below-MSA flagging) lives in the shared
  // computeVspeedTrajectory, used identically by web's VirtualRadar.tsx —
  // only the xOf/yOf pixel mapping and SVG path-string building stay local.
  const vspeedTrajectory = useMemo(() => computeVspeedTrajectory({
    currentDistNm, currentAltFt, currentVSpeedFpm, ticks: trajectoryTicks, getMsa,
  }), [currentDistNm, currentAltFt, currentVSpeedFpm, trajectoryTicks, getMsa])
  const trajectoryLine = useMemo(() => {
    const pts = vspeedTrajectory.points
    if (pts.length < 2) return { segments: [] as { path: string; below: boolean }[], dots: [] as { x: number; y: number; below: boolean }[], attitude: vspeedTrajectory.attitude }
    const withXY = pts.map((p) => ({ ...p, x: xOf(p.distNm), y: yOf(p.altFt) }))
    const segments = withXY.slice(1).map((p, i) => {
      const prev = withXY[i]
      return {
        path: `M${prev.x.toFixed(1)},${prev.y.toFixed(1)} L${p.x.toFixed(1)},${p.y.toFixed(1)}`,
        below: prev.below || p.below,
      }
    })
    return { segments, dots: withXY.slice(1).map((p) => ({ x: p.x, y: p.y, below: p.below })), attitude: vspeedTrajectory.attitude }
  }, [vspeedTrajectory, xOf, yOf])
  const trajectoryAttitudeColor =
    trajectoryLine.attitude === 'climb'   ? 'rgba(34,197,94,0.85)'  :
    trajectoryLine.attitude === 'descent' ? 'rgba(248,113,113,0.85)' :
                                             'rgba(255,255,255,0.55)'
  const DANGER_COLOR = 'rgba(239,68,68,0.95)'

  // Aircraft pitch tilt — nose up on climb, nose down on descent (visual flourish)
  const pitchDeg = useMemo(() => {
    if (currentVSpeedFpm == null) return 0
    return Math.max(-20, Math.min(20, currentVSpeedFpm / 100))
  }, [currentVSpeedFpm])

  // Category-shaped marker (fixed-wing/glider/helicopter/gyrocopter) instead
  // of always the same generic single-engine-airplane silhouette — see
  // aircraftSilhouette.ts header for why only these four groups exist.
  const silhouette = useMemo(
    () => getAircraftSilhouette(aircraftProfile?.category),
    [aircraftProfile?.category],
  )

  const onChartLayout = useCallback((e: LayoutChangeEvent) => {
    setChartW(e.nativeEvent.layout.width)
  }, [])

  if (!profile || profile.totalNm === 0) return null

  const yTicks = niceYTicks(yMax)
  const xTickCount = 6
  const xTicks = Array.from({ length: xTickCount + 1 }, (_, i) => (totalNm / xTickCount) * i)

  // Wind row under the x axis (mirrors web's VirtualRadar): station barbs
  // (priority 0) beat ground-model barbs (priority 1); each keeps its route
  // position and degrades dir/kt text -> barb only -> not drawn when it would
  // overlap a tick label, another barb or the chart edge.
  type RowWind = { dirDeg: number | null; speedKt: number; calm: boolean }
  const windRow = (() => {
    const winds = new Map<string, { distNm: number; wind: RowWind; priority: number }>()
    for (const [i, m] of weatherMarks.entries()) {
      if (m.wind) winds.set(`st-${i}`, { distNm: m.distNm, wind: { dirDeg: m.wind.dirDeg ?? null, speedKt: m.wind.speedKt, calm: !!m.wind.calm }, priority: 0 })
    }
    const stationNms = weatherMarks.filter((m) => m.wind).map((m) => m.distNm)
    for (const [ci, col] of windAloft.entries()) {
      const g = col.levels.find((l) => l.surface)
      if (!g || stationNms.some((d) => Math.abs(d - col.distNm) < WIND_ROW_STATION_SEP_NM)) continue
      winds.set(`gr-${ci}`, { distNm: col.distNm, wind: { dirDeg: g.dirDeg, speedKt: g.speedKts, calm: g.speedKts === 0 }, priority: 1 })
    }
    const labelOf = (w: RowWind) => w.calm ? 'CALM' : w.dirDeg == null ? '' : `${String(w.dirDeg).padStart(3, '0')}\u00b0/${w.speedKt}`
    const minPx = MARGIN_L + WIND_ROW_EDGE_L_PX, maxPx = MARGIN_L + plotW - WIND_ROW_EDGE_R_PX
    const items: WindRowItem[] = [...winds.entries()].map(([key, v]) => ({
      key, priority: v.priority,
      // Clamped into the margin: departure/destination stations sit exactly on
      // the plot edges, and a small nudge keeps their barb clear of the "0" tick.
      px: Math.min(Math.max(xOf(v.distNm), minPx), maxPx),
      labelW: labelOf(v.wind).length * WIND_ROW_FONT * 0.62,
    }))
    return layoutWindRow(items, {
      // The "0" tick is skipped: the departure METAR sits there.
      tickPx: xTicks.filter((d) => d > 0).map((d) => xOf(d)),
      minPx, maxPx, leftLimitPx: MARGIN_L, rightLimitPx: contentW - 2,
    }).map((pl) => ({ ...pl, wind: winds.get(pl.key)!.wind, text: labelOf(winds.get(pl.key)!.wind), model: pl.key.startsWith('gr-') }))
  })()

  return (
    <View style={[styles.panel, collapsed && styles.panelCollapsed]}>
      {/* Drag handle + header merged into one compact row — title text and
          the separate header row were removed entirely to reclaim vertical
          space (distance is already visible via the X-axis; mode context
          [planned/look-ahead] wasn't worth a dedicated text row). The grip
          is absolutely centred so the PROJ toggle can sit at the right edge
          of the same row without fighting it for layout space. */}
      <View style={styles.dragHandle} {...panResponder.panHandlers}>
        <View style={styles.headerSide}>{headerStart}</View>
        <View style={styles.dragGrip} />
        <View style={[styles.headerSide, styles.headerSideEnd]}>
          {headerEnd}
          <TouchableOpacity
            style={[styles.projBtn, showWindAloft && styles.projBtnOn]}
            onPress={() => setShowWindAloft(v => !v)}
          >
            <Text style={[styles.projBtnTxt, showWindAloft && styles.projBtnTxtOn]}>WIND</Text>
          </TouchableOpacity>
          {perf && (
            <TouchableOpacity
              style={[styles.projBtn, showProjection && styles.projBtnOn]}
              onPress={() => setShowProjection(v => !v)}
            >
              <Text style={[styles.projBtnTxt, showProjection && styles.projBtnTxtOn]}>PROJ</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
      {/* ── Chart ──────────────────────────────────────────────────── */}
      {!collapsed && (
        <View style={[styles.chartWrap, { height: chartH }]} onLayout={onChartLayout}>
          {chartW > 0 && (
            <>
              {/* Cross-track deviation badge — the chart's terrain/airspace/
                  MSA data is only ever sampled along the *planned* route
                  (see AGENTS.md / virtualRadarCalc header), so once the
                  aircraft has meaningfully diverged from that line, what's
                  drawn ahead of the "you are here" marker no longer reflects
                  what's actually ahead of the aircraft. Re-deriving the
                  whole chart from the live GPS track would fix this properly;
                  this is the cheaper stopgap — just surface the fact plainly
                  rather than silently keep drawing planned-route terrain
                  under a marker no longer really on it. */}
              {/* No terrain at all (offline without the hillshade download, or
                  the elevation API down): say so, since the missing ground
                  line also means no MSA and AGL airspace bands at raw height. */}
              {terrainFailed && terrainPts.length === 0 && (
                <View style={[styles.offTrackBadge, { top: MARGIN_T + 14 + (crossTrackNm != null && Math.abs(crossTrackNm) > OFF_TRACK_BADGE_NM ? 18 : 0) }]} pointerEvents="none">
                  <Text style={styles.offTrackTxt}>⚠ No terrain data: MSA unavailable, AGL limits at raw height</Text>
                </View>
              )}
              {crossTrackNm != null && Math.abs(crossTrackNm) > OFF_TRACK_BADGE_NM && (
                // top sits just below the waypoint-name label row (MARGIN_T=26
                // + its own text height) rather than at top:2 alongside it —
                // that used to land directly on top of the wind-arrow/
                // wind row and the
                // waypoint-name row (MARGIN_T), overlapping their text with
                // this badge's own (a long, wide string) instead of just
                // sharing empty chart background the way the scroll hint does.
                <View style={styles.offTrackBadge} pointerEvents="none">
                  <Text style={styles.offTrackTxt}>⚠ {Math.abs(crossTrackNm).toFixed(1)}nm off planned track</Text>
                </View>
              )}
              {/* Scroll hint — only shown once the route is
                  wider than the panel (MIN_PX_PER_NM above). No longer needs
                  to dodge the off-track badge — that now sits on its own row
                  well below this one instead of sharing top:2. */}
              {scrollable && (
                <View style={styles.scrollHintWrap} pointerEvents="none">
                  <Text style={styles.scrollHintTxt}>↔ scroll</Text>
                </View>
              )}
              {/* Scrollable clip window — width pinned to the panel (chartW);
                  the wider content view inside is translated by -scrollX
                  on the UI thread (contentStyle).
                  Touch handling lives here (fixed viewport), not on the
                  translated inner view, so the gesture's x stays in stable
                  viewport coordinates regardless of scroll. */}
              <GestureDetector gesture={scrub}>
              <View style={{ width: chartW, height: chartH, overflow: 'hidden' }}>
              <Animated.View style={[{ width: contentW, height: chartH }, contentStyle]}>
              <Svg width={contentW} height={chartH}>
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
                  <LinearGradient id="cloudGrad" x1="0" y1="0" x2="0" y2="1">
                    <Stop offset="0%"   stopColor={CLOUD_COLORS.fillTop}    stopOpacity={CLOUD_COLORS.fillTopOpacity} />
                    <Stop offset="100%" stopColor={CLOUD_COLORS.fillBottom} stopOpacity={CLOUD_COLORS.fillBottomOpacity} />
                  </LinearGradient>
                  <LinearGradient id="cloudGradConvective" x1="0" y1="0" x2="0" y2="1">
                    <Stop offset="0%"   stopColor={CLOUD_COLORS.convectiveFillTop}    stopOpacity={CLOUD_COLORS.fillTopOpacity} />
                    <Stop offset="100%" stopColor={CLOUD_COLORS.convectiveFillBottom} stopOpacity={CLOUD_COLORS.fillBottomOpacity} />
                  </LinearGradient>
                </Defs>

                {/* Sky background */}
                <Path d={`M0,0 L${contentW},0 L${contentW},${chartH} L0,${chartH} Z`} fill="url(#sky)" />

                {/* Y-axis grid lines */}
                {yTicks.map((ft, i) => (
                  <SvgLine key={`yg-${i}`} x1={MARGIN_L} y1={yOf(ft)} x2={contentW - MARGIN_R} y2={yOf(ft)}
                    stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
                ))}

                {/* ── Airspace (glow halo + fill + border) ── */}
                {/* Per style (@open-vfr/shared/airspaceOutline): the area is filled once and
                    every sector keeps its own border except pieces inside another sector
                    of the same kind, so a 2500 ft floor inside a 1500 ft sector draws no
                    line while the line between touching sectors stays. Band
                    tops are clamped to yMax -- it only scales to planned altitude and
                    terrain, not airspace ceilings, and one FL660 CTA must not blow the
                    scale out or draw through the wind-arrow/waypoint-name row. */}
                {airspaceOutlines(profile.airspaceBands, yMax).map((shape, i) => {
                  const fillD = shape.loops
                    .map((loop) => 'M' + loop.map(([nm, ft]) => `${xOf(nm)},${yOf(ft)}`).join(' L') + ' Z')
                    .join(' ')
                  const lineD = shape.segments
                    .map(([x1, y1, x2, y2]) => `M${xOf(x1)},${yOf(y1)} L${xOf(x2)},${yOf(y2)}`)
                    .join(' ')
                  return (
                    <G key={`band-${i}`}>
                      <Path d={fillD} fill={shape.fill} fillRule="evenodd" />
                      {/* Inset band: wide translucent stroke clipped to the inside of the area */}
                      <Defs><ClipPath id={`airspace-clip-${i}`}><Path d={fillD} fillRule="evenodd" /></ClipPath></Defs>
                      <Path d={lineD} fill="none" stroke={shape.border} strokeOpacity={0.3} strokeWidth={10} clipPath={`url(#airspace-clip-${i})`} />
                      <Path d={lineD} fill="none" stroke={shape.border} strokeWidth={1.25} strokeLinecap="square" />
                    </G>
                  )
                })}

                {/* Label chips: class letter (or designator) + first radio
                    frequency, laid out so neighbouring sectors' chips never
                    cover each other (see layoutAirspaceChips). */}
                {layoutAirspaceChips(airspaceChips(profile.airspaceBands, yMax), xOf, yOf).map((p, i) => {
                  const { chip: c, px: x, py: y, tagW, freqW, w, h } = p
                  return (
                    <G key={`chip-${i}`}>
                      <Rect x={x} y={y} width={w} height={h} fill="#fff" stroke={c.border} strokeWidth={1} rx={1.5} />
                      <Rect x={x} y={y} width={tagW} height={h} fill={c.border} rx={1.5} />
                      <SvgText x={x + tagW / 2} y={y + 10} textAnchor="middle" fontSize={9.5} fontWeight="700" fill="#fff">{c.tag}</SvgText>
                      {p.showFreq ? <SvgText x={x + tagW + freqW / 2} y={y + 10} textAnchor="middle" fontSize={9.5} fontWeight="600" fill="#111">{c.freq}</SvgText> : null}
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

                {/* Weather: one cloud glyph per METAR/TAF cloud group
                     (@open-vfr/shared/cloudGlyph): flat bottom at the
                     reported base, lumpy tops of fixed pixel height (tops
                     aren't reported, so they mean no altitude), cover shown
                     as how much of the station's strip holds cloud, CB/TCU
                     as a tower/anvil in a warning colour. Drawn across a
                     fixed-width strip around the station (a point
                     observation) rather than interpolated between stations.
                     Reports taken far off the route fade out, then drop. */}
                {(() => {
                  // Label slots already claimed: airspace chips first, then
                  // each cloud label as it's placed.
                  const taken: LabelRect[] = layoutAirspaceChips(airspaceChips(profile.airspaceBands, yMax), xOf, yOf)
                    .map((p) => ({ x: p.px, y: p.py, w: p.w, h: p.h }))
                  const plotTop = MARGIN_T, plotBottom = MARGIN_T + plotH
                  const halfWidthNm = cloudStripHalfWidthNm(totalNm)
                  const shapes: React.ReactNode[] = []
                  const labels: React.ReactNode[] = []
                  weatherMarks.forEach((m, i) => {
                    const opacity = cloudOpacityForOffset(cloudReportOffRouteNm(m.offRouteNm, m.station))
                    if (opacity === 0) return
                    const x1 = xOf(Math.max(0, m.distNm - halfWidthNm))
                    const x2 = xOf(Math.min(totalNm, m.distNm + halfWidthNm))
                    const cx = (x1 + x2) / 2
                    m.clouds.forEach((c, j) => {
                      const yb = yOf(c.baseFt)
                      if (yb < plotTop + 4) return  // base above the plotted range
                      const accent = c.type === 'CB' ? CLOUD_COLORS.cb : c.type === 'TCU' ? CLOUD_COLORS.tcu : null
                      cloudLayerPaths(x1, x2, yb, c, i * 7 + j, yb - plotTop).forEach((d, k) => shapes.push(
                        <Path key={`cloud-${i}-${j}-${k}`} d={d} opacity={opacity}
                          fill={accent ? 'url(#cloudGradConvective)' : 'url(#cloudGrad)'}
                          stroke={accent ?? CLOUD_COLORS.stroke} strokeWidth={accent ? 1.25 : 0.75} />,
                      ))
                      const text = cloudLayerLabel(c) + (j === 0 ? ` ${cloudReportIcao(m.station)}` : '')
                      const glyphH = Math.min(cloudGlyphHeight(c), yb - plotTop)
                      const y = placeCloudLabel(cx, yb, glyphH, text, taken, plotTop, plotBottom)
                      labels.push(
                        <G key={`cloud-label-${i}-${j}`}>
                          {renderHaloText(cx, y, text, accent ?? CLOUD_COLORS.label, 9, opacity, 'middle')}
                        </G>,
                      )
                    })
                  })
                  return <>{shapes}{labels}</>
                })()}

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

                {/* Winds aloft: barbs at each standard pressure level's nominal
                    altitude (model forecast), mirrors web's VirtualRadar. */}
                {windAloft.flatMap((col, ci) => col.levels.map((lv) => {
                  // Surface (10 m) wind is part of the wind row under the x axis.
                  if (lv.surface || lv.altFt > yMax * 0.96) return null
                  const x = windXOf(col.distNm), y = yOf(lv.altFt)
                  const color = windBarbColorForSpeed(lv.speedKts)
                  const label = lv.speedKts === 0 ? 'CALM' : `${String(lv.dirDeg).padStart(3, '0')}°/${lv.speedKts}`
                  const p = windLabelPlacement(x, 8, label, 9, contentW - MARGIN_R, MARGIN_L)
                  return (
                    <G key={`windaloft-${ci}-${lv.altFt}`} opacity={0.85}>
                      {lv.speedKts === 0
                        ? <Circle cx={x} cy={y} r={3} fill="none" stroke="rgba(148,163,184,0.8)" strokeWidth={1} />
                        : (
                          <G transform={`translate(${x},${y}) rotate(${lv.dirDeg}) translate(0, 8)`}>
                            {renderWindBarbShape(lv.speedKts, color, { shaftLen: 16, barbLen: 7, halfLen: 4, barbGap: 4, strokeW: 1.5 })}
                          </G>
                        )}
                      {p && renderHaloText(p.x, y + 3, label, color, 9, 1, p.anchor)}
                    </G>
                  )
                }))}

                {/* ── Projected flight path (PROJ toggle) ─────────────── */}
                {showProjection && perf && projSafePath && (
                  <Path d={projSafePath} fill="none" stroke="rgba(0,220,255,0.90)" strokeWidth={2} />
                )}
                {showProjection && perf && projDangerPath && (
                  <Path d={projDangerPath} fill="none" stroke="rgba(239,68,68,0.95)" strokeWidth={2.5} />
                )}

                {/* Wind row under the x axis (see windRow above). */}
                {windRow.map((w) => {
                  const x = w.px, y = MARGIN_T + plotH + WIND_ROW_DY
                  if (w.wind.dirDeg == null && !w.wind.calm) {
                    return <Circle key={`windrow-${w.key}`} cx={x} cy={y} r={3} fill="none" stroke="rgba(250,204,21,0.7)" strokeWidth={1} strokeDasharray="1.5,1.5" />
                  }
                  const color = w.wind.calm ? 'rgba(203,213,225,0.95)' : windBarbColorForSpeed(w.wind.speedKt)
                  return (
                    <G key={`windrow-${w.key}`} opacity={w.model ? 0.85 : 1}>
                      {w.wind.calm
                        ? <Circle cx={x} cy={y} r={3} fill="none" stroke="rgba(148,163,184,0.8)" strokeWidth={1} />
                        : (
                          // dirDeg is the meteorological FROM bearing; the shaft
                          // points FROM. Rotation is re-centred on the shaft's
                          // midpoint so the glyph stays balanced about y.
                          <G transform={`translate(${x},${y}) rotate(${w.wind.dirDeg}) translate(0, ${WIND_BARB_SHAFT_LEN / 2})`}>
                            {renderWindBarbShape(w.wind.speedKt, color, { shaftLen: WIND_BARB_SHAFT_LEN, barbLen: WIND_BARB_BARB_LEN, halfLen: WIND_BARB_HALF_LEN, barbGap: WIND_BARB_BARB_GAP, strokeW: WIND_BARB_STROKE_W })}
                          </G>
                        )}
                      {w.label === 'right' && renderHaloText(x + 9 + 4, y + 3, w.text, color, WIND_ROW_FONT, 1, 'start')}
                      {w.label === 'left' && renderHaloText(x - 9 - 4, y + 3, w.text, color, WIND_ROW_FONT, 1, 'end')}
                    </G>
                  )
                })}

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

                {/* ── Vertical-speed-aware trajectory line ────────────────
                     Climb/descent/level colour follows the *current* vspeed,
                     linearly extrapolated to each distance tick above —
                     distinct from the yellow dashed distance/time ticks
                     (which stay purely horizontal reference marks) and from
                     the PROJ toggle's full performance-model path (which
                     needs an aircraft profile and models level-off/climb
                     schedule; this one is always available). */}
                {trajectoryLine.segments.map((seg, i) => (
                  <Path key={`trajseg-${i}`} d={seg.path} fill="none"
                    stroke={seg.below ? DANGER_COLOR : trajectoryAttitudeColor}
                    strokeWidth={seg.below ? 2.25 : 1.75} strokeDasharray="1,2" />
                ))}
                {trajectoryLine.dots.map((p, i) => (
                  <Circle key={`trajdot-${i}`} cx={p.x} cy={p.y} r={p.below ? 3 : 2.5}
                    fill={p.below ? DANGER_COLOR : trajectoryAttitudeColor} />
                ))}

                {/* ── Live position marker + aircraft silhouette ──────── */}
                {currentDistNm != null && (
                  <SvgLine x1={xOf(currentDistNm)} y1={MARGIN_T} x2={xOf(currentDistNm)} y2={MARGIN_T + plotH}
                    stroke="rgba(255,255,255,0.40)" strokeWidth={1} strokeDasharray="3,3" />
                )}
                {currentDistNm != null && currentAltFt != null && (
                  <G transform={`translate(${xOf(currentDistNm)}, ${yOf(currentAltFt)}) rotate(${-pitchDeg})`}>
                    <Circle r={13} fill="rgba(34,197,94,0.18)" />
                    {silhouette.map((part, i) => (
                      <Path key={`ac-part-${i}`} d={part.d} fill={part.fill ?? '#ffffff'} fillOpacity={part.opacity} />
                    ))}
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
                  instead of re-adding as-is.

                  Sized to contentW (not chartW) and left inside the
                  translated content view below — it scrolls together with
                  the Svg. Only the Y-axis tick labels are pinned outside
                  this, in a separate non-scrolling overlay after the clip
                  window closes. */}
              <View style={{ position: 'absolute', left: 0, top: 0, width: contentW, height: chartH }} pointerEvents="none">
                {profile.obstacles.map((obs, i) => {
                  const baseFt = Math.max(obs.elevationFt, terrainAt(terrainPts, obs.distNm))
                  const tipFt  = obs.heightM > 0 ? Math.round(baseFt + obs.heightM * 3.28084) : baseFt
                  const icon = OBSTACLE_ICONS[obs.kind] ?? OBSTACLE_ICON_FALLBACK
                  const size = 16
                  return (
                    // Anchor by BOTTOM edge at the tip point, growing
                    // UPWARD from it -- a top-anchor's fixed pixel height
                    // extends DOWNWARD from tipFt instead, which for a
                    // short/zero-height obstacle (tipFt near baseFt, itself
                    // near the chart floor) has nowhere to go but below true
                    // 0ft/ground -- same failure mode as the original
                    // center-anchor bug, just via a different path. Mirrors
                    // web's identical fix.
                    <Image
                      key={`obs-${i}`}
                      source={icon}
                      style={{ position: 'absolute', width: size, height: size, left: xOf(obs.distNm) - size / 2, top: yOf(tipFt) - size }}
                      resizeMode="contain"
                    />
                  )
                })}

                {profile.landmarks.map((lmk, i) => {
                  // Floor at 0 -- see web VirtualRadar.tsx's identical fix
                  // for the full rationale: unlike obstacles (floored via
                  // Math.max against their own surveyed elevationFt),
                  // landmarks rely purely on terrainAt(), which can go
                  // negative from real DEM noise over/near water.
                  const baseFt = Math.max(0, terrainAt(terrainPts, lmk.distNm))
                  const icon = LANDMARK_ICONS[lmk.kind] ?? LANDMARK_ICON_FALLBACK
                  const size = 14
                  return (
                    // Anchor by BOTTOM edge, not center -- yOf(baseFt) here
                    // is ground; mirrors web's identical fix.
                    <Image
                      key={`lmk-${i}`}
                      source={icon}
                      style={{ position: 'absolute', width: size, height: size, left: xOf(lmk.distNm) - size / 2, top: yOf(baseFt) - size }}
                      resizeMode="contain"
                    />
                  )
                })}

                {/* Renders visibleWaypointTicks (collision-filtered above),
                    not the raw profile.waypointTicks list -- see the memo
                    comment near windXOf. */}
                {(() => {
                  // A label that would sit on an airspace chip drops below it
                  // (chips can reach the plot's top edge, where the
                  // waypoint-name row lives).
                  const chips = layoutAirspaceChips(airspaceChips(profile.airspaceBands, yMax), xOf, yOf)
                  const WP_LABEL_H = 12
                  return visibleWaypointTicks.map((tick) => {
                    // Clamp so the destination's label (sitting exactly at the
                    // right edge of the *content* — not the panel, since this
                    // whole overlay scrolls with the Svg — doesn't overflow
                    // past contentW and get clipped to just its first letter.
                    const left = Math.min(contentW - 44, xOf(tick.distNm) + 2)
                    const w = Math.min(60, tick.name.length * 6 + 4)
                    let top = MARGIN_T
                    for (let guard = 0; guard < 4; guard++) {
                      const hit = chips.find((c) =>
                        left < c.px + c.w && c.px < left + w && top < c.py + c.h && c.py < top + WP_LABEL_H)
                      if (!hit) break
                      top = hit.py + hit.h + 1
                    }
                    return (
                      <Text
                        key={`wpl-${tick.distNm}-${tick.name}`}
                        style={[styles.wpLabel, { left, top }]}
                        numberOfLines={1}
                      >
                        {tick.name}
                      </Text>
                    )
                  })
                })()}

                {trajectoryTickNms.map((d, i) => (
                  <Text key={`trajl-${i}`} style={[styles.trajLabel, { left: xOf(d) - 8, top: MARGIN_T - 10 }]}>
                    {trajectoryTickLabels[i]}
                  </Text>
                ))}

                {/* No dir/speed text label alongside the barb -- see the
                    map's identical fix (AviationMap.tsx's removed
                    'wind-arrows-label' layer): the barb shape itself
                    (feather count + speed-tiered colour) already carries
                    the at-a-glance strength read, and a tiny permanent
                    text label at this chart's scale was flagged as
                    illegible in a pre-release pass. */}


                {xTicks.map((d, i) => {
                  // Centres the label under its tick mark by actual text
                  // width instead of a fixed -8px offset -- that assumed
                  // every number was ~2 digits wide, so single-digit ticks
                  // ("0", "6") sat visibly off-centre from the tick line
                  // above them, more so after the fontSize bump widened
                  // the fixed-offset error further. Same char-width*
                  // fontSize*0.62 estimate used elsewhere in this chart
                  // (e.g. the wind labels), halved for a center offset.
                  const label = nmToDisplay(d, units.distance).toFixed(0)
                  const halfW = label.length * 9 * 0.31
                  return (
                    <Text key={`xl-${i}`} style={[
                      styles.axisLabelX,
                      // Floor at MARGIN_L, not 0: left of it is the pinned
                      // axis column, which would cover part of the "0" label.
                      { left: Math.min(contentW - 20, Math.max(MARGIN_L, xOf(d) - halfW)), top: MARGIN_T + plotH + 4 },
                    ]}>
                      {label}
                    </Text>
                  )
                })}
              </View>
              </Animated.View>
              {/* Scrub crosshair: fixed to the viewport, positioned on the
                  UI thread (crosshairStyle) so it tracks the finger without
                  re-rendering the chart. */}
              <Animated.View pointerEvents="none" style={[styles.crosshair, { top: MARGIN_T, height: plotH }, crosshairStyle]}>
                <Svg width={2} height={plotH}>
                  <SvgLine x1={1} y1={0} x2={1} y2={plotH} stroke="rgba(250,204,21,0.85)" strokeWidth={1.5} strokeDasharray="4,3" />
                </Svg>
              </Animated.View>
              </View>
              </GestureDetector>
              {/* Pinned Y-axis tick labels — rendered outside the scrollable
                  clip window (above) so they stay fixed at the left edge
                  regardless of scrollX, instead of scrolling away with the
                  route content like everything else in this chart does.
                  Opaque sky-coloured backing from just above the top tick
                  down: scrolled content (airspace, chips, clouds, terrain,
                  x-axis labels) disappears at the axis line instead of
                  sliding underneath the FL labels. The wind/waypoint row
                  above stays uncovered -- nothing pinned sits there. */}
              <View style={styles.yAxisPinned} pointerEvents="none">
                <Svg style={StyleSheet.absoluteFill} width={MARGIN_L} height={chartH}>
                  <Defs>
                    <LinearGradient id="skyAxis" x1="0" y1="0" x2="0" y2={chartH} gradientUnits="userSpaceOnUse">
                      <Stop offset="0%"   stopColor="#0d1424" stopOpacity={1} />
                      <Stop offset="70%"  stopColor="#141b30" stopOpacity={1} />
                      <Stop offset="100%" stopColor="#1a2338" stopOpacity={1} />
                    </LinearGradient>
                  </Defs>
                  <Rect x={0} y={AXIS_COVER_TOP} width={MARGIN_L} height={chartH - AXIS_COVER_TOP} fill="url(#skyAxis)" />
                  <SvgLine x1={MARGIN_L - 0.5} y1={AXIS_COVER_TOP} x2={MARGIN_L - 0.5} y2={MARGIN_T + plotH}
                    stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
                </Svg>
                {yTicks.map((ft, i) => (
                  <Text key={`yl-${i}`} style={[styles.axisLabel, { left: 2, top: yOf(ft) - 6 }]}>
                    {ft >= 1000 ? `FL${Math.round(ft / 100).toString().padStart(3, '0')}` : `${ft}`}
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

function makeStyles(theme: ScaledTheme) {
 return {
  panel: {
    backgroundColor: theme.surfacePanel,
    borderTopWidth:  1,
    borderColor:     theme.borderDefault,
  },
  panelCollapsed: {},
  // 30 (was 22): the row also hosts tappable controls (ruler clear, PROJ),
  // and Android never delivers touches outside a parent's bounds, so a
  // child's hitSlop can't make up for a short row.
  dragHandle: {
    height:          30,
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'center',
    backgroundColor: theme.surfaceOverlay,
  },
  // Equal flex on both sides keeps the grip centred regardless of how much
  // content either slot holds.
  headerSide: {
    flex:              1,
    flexDirection:     'row',
    alignItems:        'center',
    paddingHorizontal: theme.space2,
    gap:               theme.space2,
    overflow:          'hidden',
  },
  headerSideEnd: {
    justifyContent: 'flex-end',
  },
  dragGrip: {
    width:           48,
    height:          5,
    borderRadius:    3,
    backgroundColor: theme.textMuted,
  },
  projBtn: {
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
    fontSize: 10,
    maxWidth: 60,
  },
  trajLabel: {
    position: 'absolute',
    color:    'rgba(250,204,21,0.90)',
    fontSize: 9,
    fontWeight: '600',
  },
  axisLabel: {
    position: 'absolute',
    color:    'rgba(255,255,255,0.45)',
    fontSize: 9,
  },
  axisLabelX: {
    position: 'absolute',
    color:    'rgba(255,255,255,0.45)',
    fontSize: 9,
  },
  // Pinned left-edge Y-axis label column — sits above the scrollable clip
  // window (rendered after it in JSX = higher z-order) so it never scrolls
  // away with the route content. No background fill: same translucent-
  // text-over-terrain look the chart already used before scrolling existed.
  crosshair: {
    position: 'absolute',
    left:     -1,
    width:    2,
  },
  yAxisPinned: {
    position: 'absolute',
    left:     0,
    top:      0,
    width:    MARGIN_L,
    height:   '100%',
  },
  offTrackBadge: {
    position:          'absolute',
    top:               MARGIN_T + 14,
    left:              MARGIN_L + 2,
    backgroundColor:   'rgba(120,53,15,0.85)',
    borderRadius:      theme.radiusSm,
    paddingHorizontal: 6,
    paddingVertical:   2,
    zIndex:            5,
  },
  offTrackTxt: {
    color:      '#fde68a',
    fontSize:   9,
    fontWeight: '700',
  },
  scrollHintWrap: {
    position:          'absolute',
    top:               2,
    right:             MARGIN_R + 2,
    backgroundColor:   'rgba(15,23,42,0.65)',
    borderRadius:      theme.radiusSm,
    paddingHorizontal: 5,
    paddingVertical:   1,
  },
  scrollHintTxt: {
    color:    'rgba(255,255,255,0.55)',
    fontSize: 8,
  },
} as const
}
