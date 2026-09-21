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
  getMsaLookup,
  computeTrajectoryTicks,
  computeVspeedTrajectory,
  projectWeatherMarks,
  type TerrainPoint,
  type MsaPoint,
  type AircraftPerfModel,
} from '@open-vfr/shared/virtualRadarCalc'
import { getAircraftSilhouette } from '@open-vfr/shared/aircraftSilhouette'
import { resolveStationWeather } from '@open-vfr/shared/parseTaf'
import { windBarbColorForSpeed, windBarbGeometry } from '@open-vfr/shared/windBarb'
import { getTileUrls, API_BASE } from '../config'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import type { RouteWeatherStation } from '../hooks/useWeatherAlongRoute'
import type { WindSample } from '../hooks/useWindAlongRoute'

// ---------------------------------------------------------------------------
// Module-level GeoJSON cache — fetch + JSON.parse each of these exactly once
// per app lifetime, not once per VerticalProfile *mount*.
//
// Without this, every fresh mount (ruler mode turned on, route planned,
// look-ahead engaged after a route is cleared, etc. — each is a distinct
// branch in MapScreen's render ternary, so switching between them unmounts
// and remounts this component) re-fetched and re-JSON.parsed all four files
// (airspace, obstacles, water, landmarks) from scratch. `JSON.parse` of a
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
  /** Regular-interval wind samples (from useWindAlongRoute), independent of
   *  aerodrome positions -- fills the gaps between weatherStations' arrows.
   *  Mirrors web's identical prop. Omit to hide entirely. */
  windSamples?: WindSample[]
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

// DEFAULT_CHART_H bumped 190->206 (+16px) in lockstep with MARGIN_T's
// 10->26 (+16px) below -- reserves real headroom above the plot for wind
// arrows (see WIND_ARROW_Y) without shrinking the plot itself (plotH stays
// chartH - MARGIN_T - MARGIN_B = same value either way). Mirrors web's
// identical VirtualRadar.tsx chartWrap/margin.top change.
export const DEFAULT_CHART_H  = 206
export const MIN_CHART_H      = 0
export const MAX_CHART_H      = 340
export const COLLAPSE_THRESHOLD = 24   // below this, treat as "collapsed"
const MARGIN_L  = 34   // room for FL/alt ticks
const MARGIN_R  = 10
const MARGIN_T  = 26
const MARGIN_B  = 18
// Wind arrow vertical position, within the reserved top margin ABOVE the
// waypoint-name label row (which sits at top: MARGIN_T, i.e. pixel 26) --
// previously arrows sat at MARGIN_T+9 (pixel 19 with the old MARGIN_T=10),
// fighting the waypoint-name row for the same few pixels.
const WIND_ARROW_Y   = 12
const WIND_LABEL_TOP = 20

// Never compress a long route down to fit the panel width —
// below this pixel-per-NM density the chart becomes horizontally scrollable
// instead of squeezing the whole route in, so short legs stay legible. Only
// kicks in once totalNm * MIN_PX_PER_NM exceeds the panel's actual width.
// Bumped 18->30 -- mirrors web's identical fix (see VirtualRadar.tsx):
// at 18, almost any panel width fits a 40-50nm route without ever needing
// to scroll, so the scroll path effectively never activated for realistic
// route lengths even though labels were visibly cramped well before that.
const MIN_PX_PER_NM = 30
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

function getPlannedAlt(altProfile: { distNm: number; altFt: number }[], distNm: number): number {
  let alt = altProfile[0]?.altFt ?? 0
  for (const p of altProfile) {
    if (p.distNm <= distNm) alt = p.altFt
    else break
  }
  return alt
}


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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VerticalProfile({
  waypoints, legOverrides, units = DEFAULT_UNITS, airspaceCeilingFt, title, aircraftProfile,
  currentDistNm, currentAltFt, currentSpeedKts, currentVSpeedFpm, trajectoryMode, trajectoryNm = 5,
  crossTrackNm, weatherStations, windSamples,
  height = DEFAULT_CHART_H, onHeightChange, onHoverDistNm,
}: Props) {
  const styles = useThemedStyles(makeStyles)
  const [hoverNm, setHoverNm] = useState<number | null>(null)
  const [airspaceGeo, setAirspaceGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [obstacleGeo, setObstacleGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [waterGeo,    setWaterGeo]    = useState<GeoJSON.FeatureCollection | null>(null)
  const [landmarkGeo, setLandmarkGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [terrainPts, setTerrainPts]   = useState<TerrainPoint[]>([])
  const [msaPts,     setMsaPts]       = useState<MsaPoint[]>([])
  const [showProjection, setShowProjection] = useState(false)
  const [chartW,      setChartW]      = useState(0)
  // Horizontal scroll offset into the (possibly wider-than-panel) chart
  // content — see MIN_PX_PER_NM above. 0 when the route fits the panel.
  const [scrollX,     setScrollX]     = useState(0)

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

  // Load GeoJSON once per app lifetime (module-level cache above) — cheap on
  // every mount after the first, since repeat calls just resolve an
  // already-settled promise instead of re-fetching/re-parsing.
  useEffect(() => {
    loadGeoJsonOnce(getTileUrls().airspace).then(setAirspaceGeo).catch(() => {})
    loadGeoJsonOnce(getTileUrls().obstacles).then(setObstacleGeo).catch(() => {})
    loadGeoJsonOnce(getTileUrls().water).then(setWaterGeo).catch(() => { /* optional layer — offline-safe no-op */ })
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
    // API_BASE, not TILE_BASE -- /api/elevation/ is proxied by the api
    // server's nginx, a different host from TILE_BASE (which in production
    // points at the R2 tiles bucket domain, tiles.openvfr.org). Using
    // TILE_BASE here hit the R2 bucket with a bogus path and came back with
    // a 401 misreported as "OpenTopoData HTTP 401" (found 2026-09-20).
    fetchTerrainProfile(waypoints, API_BASE, controller.signal)
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
    return buildVirtualRadarProfile(waypoints, legOverrides, airspaceGeo, obstacleGeo, waterGeo ?? undefined, landmarkGeo ?? undefined, airspaceCeilingFt ?? Infinity)
  }, [waypoints, legOverrides, airspaceGeo, obstacleGeo, waterGeo, landmarkGeo, airspaceCeilingFt])

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
    let lastX = -Infinity
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

  // Clamp scrollX whenever the scrollable range shrinks (panel resized wider,
  // or a shorter route replaces a longer one) — functional update so this
  // doesn't need to be a PanResponder dependency.
  useEffect(() => {
    setScrollX((x) => Math.min(x, maxScrollX))
  }, [maxScrollX])

  // Manual-pan grace period -- see scrubResponder's onPanResponderRelease
  // below, which sets this. Without it, the auto-follow effect's hoverNm
  // guard reopens the INSTANT a finger lifts (clearHover() sets hoverNm
  // back to null immediately on release), so this effect re-fires on the
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
  // the pilot is mid-drag (hoverNm != null) or shortly after releasing a
  // manual pan (manualPanUntilRef) so this doesn't fight a pan/scrub either
  // during or immediately after the gesture.
  useEffect(() => {
    if (currentDistNm == null || !scrollable || hoverNm != null) return
    if (Date.now() < manualPanUntilRef.current) return
    const markerX = xOf(currentDistNm)
    const EDGE = 40
    setScrollX((x) => {
      if (markerX < x + EDGE || markerX > x + chartW - EDGE) {
        return Math.max(0, Math.min(maxScrollX, markerX - chartW / 2))
      }
      return x
    })
  }, [currentDistNm, scrollable, hoverNm, chartW, maxScrollX, xOf])

  // Touch-drag over the chart plot area does double duty:
  //  1. Scrub — lets the parent screen sync a crosshair marker on the map
  //     (native equivalent of web's Recharts onMouseMove/onMouseLeave).
  //  2. Pan — when the route is wider than the panel (MIN_PX_PER_NM,
  //     above), the same one-finger drag scrolls the content instead of a
  //     separate ScrollView, which would otherwise fight this same gesture
  //     for the same horizontal touch-move (RN's ScrollView claims the
  //     responder natively; a second JS PanResponder on the same axis can't
  //     reliably out-race it). One responder driving both an internal
  //     scrollX state AND the hover crosshair keeps the two forms of
  //     horizontal drag unambiguous instead of racing two gesture systems.
  // Singleton PanResponder for the same reason as the resize-drag one above:
  // must not be recreated mid-gesture.
  const totalNmRef = useRef(totalNm); totalNmRef.current = totalNm
  const plotWRef = useRef(plotW); plotWRef.current = plotW
  const scrollXRef = useRef(scrollX); scrollXRef.current = scrollX
  const maxScrollXRef = useRef(maxScrollX); maxScrollXRef.current = maxScrollX
  const dragStartScrollXRef = useRef(0)
  const onHoverDistNmRef = useRef(onHoverDistNm); onHoverDistNmRef.current = onHoverDistNm
  const updateHover = useCallback((viewportX: number) => {
    const tNm = totalNmRef.current, pW = plotWRef.current
    if (tNm <= 0 || pW <= 0) return
    const contentX = viewportX + scrollXRef.current
    const nm = Math.max(0, Math.min(tNm, ((contentX - MARGIN_L) / pW) * tNm))
    setHoverNm(nm)
    onHoverDistNmRef.current?.(nm)
  }, [])
  const clearHover = useCallback(() => { setHoverNm(null); onHoverDistNmRef.current?.(null) }, [])
  const scrubResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      dragStartScrollXRef.current = scrollXRef.current
      updateHover(e.nativeEvent.locationX)
    },
    onPanResponderMove: (e, gs) => {
      const next = Math.max(0, Math.min(maxScrollXRef.current, dragStartScrollXRef.current - gs.dx))
      setScrollX(next)
      updateHover(e.nativeEvent.locationX)
    },
    onPanResponderRelease: () => {
      // Only arm the grace period for an actual pan (content moved) --
      // a stationary tap/scrub that never dragged the content shouldn't
      // delay auto-follow from a real position change that happens to
      // land moments later.
      if (scrollXRef.current !== dragStartScrollXRef.current) {
        manualPanUntilRef.current = Date.now() + MANUAL_PAN_GRACE_MS
      }
      clearHover()
    },
    onPanResponderTerminate: () => {
      if (scrollXRef.current !== dragStartScrollXRef.current) {
        manualPanUntilRef.current = Date.now() + MANUAL_PAN_GRACE_MS
      }
      clearHover()
    },
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

  // Weather stations projected onto the route's distance axis — wind
  // arrows + cloud-base layers drawn directly in the vertical profile, not
  // just listed in the separate WeatherAlongRouteSheet. Shared
  // with web's VirtualRadar.tsx (projectWeatherMarks handles the along-route
  // projection + [0,totalNm] filtering; only the METAR string parsing and
  // xOf/yOf pixel mapping stay local to each platform's renderer).
  // TAF only fills in wind/clouds when a station has no current METAR (see
  // resolveStationWeather / parseTaf.ts header for the full scope note —
  // this is NOT a route-position-vs-forecast-time overlay, that needs an
  // ETD field this app doesn't have). tafChangeSoon flags a real trend
  // change (FM/BECMG) in the next 3h — a nudge to go check the bulletin
  // rather than a rendered forecast.
  const weatherMarks = useMemo(() => {
    if (!weatherStations) return []
    return projectWeatherMarks(waypoints, weatherStations, totalNm).map((m) => {
      const resolved = resolveStationWeather({
        metarWind: m.station.decoded?.wind ?? null,
        metarClouds: m.station.decoded?.clouds ?? null,
        taf: m.station.taf,
      })
      return { station: m.station, distNm: m.distNm, wind: resolved.wind, clouds: resolved.clouds, tafChangeSoon: resolved.tafChangeSoon }
    })
  }, [weatherStations, waypoints, totalNm])

  // Regular-interval wind samples, filtered against weatherMarks above so a
  // sample doesn't draw a second, visibly-different (dashed/model) arrow
  // right next to a real station's arrow. Mirrors web's identical filter.
  const visibleWindSamples = useMemo(() => {
    if (!windSamples || windSamples.length === 0) return []
    const MIN_SAMPLE_SEPARATION_NM = 5
    const markDists = weatherMarks.filter((m) => m.wind).map((m) => m.distNm)
    return windSamples.filter((s) => !markDists.some((d) => Math.abs(d - s.distNm) < MIN_SAMPLE_SEPARATION_NM))
  }, [windSamples, weatherMarks])

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
              {crossTrackNm != null && Math.abs(crossTrackNm) > OFF_TRACK_BADGE_NM && (
                // top sits just below the waypoint-name label row (MARGIN_T=26
                // + its own text height) rather than at top:2 alongside it —
                // that used to land directly on top of the wind-arrow/
                // wind-label row (WIND_ARROW_Y=12 / windLabel top=8) and the
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
                  the wider content view inside is translated by -scrollX.
                  Touch handling lives here (fixed viewport), not on the
                  translated inner view, so scrubResponder's locationX stays
                  in stable viewport coordinates regardless of scroll. */}
              <View style={{ width: chartW, height: chartH, overflow: 'hidden' }} {...scrubResponder.panHandlers}>
              <View style={{ width: contentW, height: chartH, transform: [{ translateX: -scrollX }] }}>
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
                </Defs>

                {/* Sky background */}
                <Path d={`M0,0 L${contentW},0 L${contentW},${chartH} L0,${chartH} Z`} fill="url(#sky)" />

                {/* Y-axis grid lines */}
                {yTicks.map((ft, i) => (
                  <SvgLine key={`yg-${i}`} x1={MARGIN_L} y1={yOf(ft)} x2={contentW - MARGIN_R} y2={yOf(ft)}
                    stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
                ))}

                {/* ── Airspace bands (glow halo + fill + border + chip) ── */}
                {profile.airspaceBands.map((band, i) => {
                  const x1 = xOf(band.entryNm), x2 = xOf(band.exitNm)
                  // Clamp to the plot's own top edge -- yMax only scales to
                  // planned altitude/terrain (see yMax above), NOT to
                  // airspace ceilings, so a band whose upper_ft exceeds yMax
                  // (e.g. a low-level route crossing under a TMA capped at
                  // FL065) would otherwise compute a yOf() above MARGIN_T,
                  // drawing its top edge through the wind-arrow/waypoint-
                  // name row instead of stopping at the chart's visible top.
                  // Growing yMax to always fit every crossed band's ceiling
                  // isn't the fix either -- one FL660 CTA crossing would
                  // blow the whole y-scale out and squash the low-altitude
                  // terrain/obstacle detail that matters far more day to day.
                  const yTop = Math.max(MARGIN_T, yOf(band.upper_ft)), yBot = yOf(band.lower_ft)
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

                {/* Weather: cloud-base layers — translucent
                     bands from each METAR cloud group's base up to the top
                     of the plot; opacity increases FEW/SCT/BKN/OVC so a
                     ceiling reads visibly denser than scattered cloud. Drawn
                     as a fixed-width band straddling the station (a point
                     observation) rather than interpolated between stations
                     miles apart, which would imply false precision. */}
                {weatherMarks.map((m, i) => {
                  const halfWidthNm = Math.min(totalNm * 0.06, 4)
                  const x1 = xOf(Math.max(0, m.distNm - halfWidthNm))
                  const x2 = xOf(Math.min(totalNm, m.distNm + halfWidthNm))
                  const cloudOpacity: Record<string, number> = { FEW: 0.10, SCT: 0.18, BKN: 0.30, OVC: 0.42 }
                  return m.clouds.map((c, j) => (
                    <Path
                      key={`cloud-${i}-${j}`}
                      d={`M${x1},${MARGIN_T} L${x2},${MARGIN_T} L${x2},${yOf(c.baseFt)} L${x1},${yOf(c.baseFt)} Z`}
                      fill={`rgba(205,215,230,${cloudOpacity[c.cover]})`}
                    />
                  ))
                })}

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

                {weatherMarks.map((m, i) => {
                  if (!m.wind) return null
                  const x = windXOf(m.distNm), y = WIND_ARROW_Y
                  if (m.wind.calm) {
                    return <Circle key={`wind-${i}`} cx={x} cy={y} r={3} fill="none" stroke="rgba(148,163,184,0.7)" strokeWidth={1} />
                  }
                  if (m.wind.dirDeg == null) {
                    return <Circle key={`wind-${i}`} cx={x} cy={y} r={3} fill="none" stroke="rgba(250,204,21,0.7)" strokeWidth={1} strokeDasharray="1.5,1.5" />
                  }
                  const rot = m.wind.dirDeg + 180
                  // Real WMO barb (shaft + feathers) instead of a plain
                  // arrow -- mirrors web's VirtualRadar.tsx identical change.
                  const color = windBarbColorForSpeed(m.wind.speedKt)
                  return (
                    <G key={`wind-${i}`} transform={`translate(${x},${y}) rotate(${rot})`}>
                      {renderWindBarbShape(m.wind.speedKt, color, { shaftLen: 18, barbLen: 8, halfLen: 5, barbGap: 5, strokeW: 1.8 })}
                    </G>
                  )
                })}

                {/* Regular-interval wind samples (useWindAlongRoute) --
                    thinner/dashed/dimmer than a real station's arrow, same
                    reasoning as web's identical block. Already filtered
                    against weatherMarks in visibleWindSamples above. */}
                {visibleWindSamples.map((s, i) => {
                  const x = windXOf(s.distNm), y = WIND_ARROW_Y
                  if (s.wind.calm) {
                    return <Circle key={`windsample-${i}`} cx={x} cy={y} r={2.5} fill="none" stroke="rgba(148,163,184,0.4)" strokeWidth={1} strokeDasharray="1.5,1.5" />
                  }
                  if (s.wind.dirDeg == null) return null
                  const rot = s.wind.dirDeg + 180
                  const color = windBarbColorForSpeed(s.wind.speedKt)
                  return (
                    <G key={`windsample-${i}`} transform={`translate(${x},${y}) rotate(${rot})`} opacity={0.6}>
                      {renderWindBarbShape(s.wind.speedKt, color, { shaftLen: 13, barbLen: 6, halfLen: 3.5, barbGap: 3.5, strokeW: 1.4 })}
                    </G>
                  )
                })}

                {/* TAF "check the bulletin" warning — small yellow triangle
                     when a real trend change (FM/BECMG) lands within the
                     next 3h (see resolveStationWeather/parseTaf.ts). Not a
                     rendered forecast column — just a nudge to go read the
                     TAF text. */}
                {weatherMarks.map((m, i) => m.tafChangeSoon ? (
                  <Path key={`tafwarn-${i}`}
                    d="M0,-5 L4.5,4 L-4.5,4 Z"
                    // Fixed near the true top (y=0), above WIND_ARROW_Y's
                    // span (~3-21px) at the same x -- was MARGIN_T-8 (pixel
                    // 2 with the old MARGIN_T=10), which would now land
                    // right inside the wind arrow's own span after
                    // MARGIN_T grew to 26.
                    transform={`translate(${xOf(m.distNm)},0)`}
                    fill="rgba(250,204,21,0.9)" stroke="rgba(0,0,0,0.4)" strokeWidth={0.5}
                  />
                ) : null)}

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
                    {silhouette.map((part, i) => (
                      <Path key={`ac-part-${i}`} d={part.d} fill="#ffffff" fillOpacity={part.opacity} />
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
                {visibleWaypointTicks.map((tick) => (
                  // Clamp so the destination's label (sitting exactly at the
                  // right edge of the *content* — not the panel, since this
                  // whole overlay scrolls with the Svg — doesn't overflow
                  // past contentW and get clipped to just its first letter.
                  <Text
                    key={`wpl-${tick.distNm}-${tick.name}`}
                    style={[styles.wpLabel, { left: Math.min(contentW - 44, xOf(tick.distNm) + 2), top: MARGIN_T }]}
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

                {/* Text drawn to the RIGHT of the arrow, not below it, and
                    only when it fits before the content's right edge --
                    mirrors web's identical fix. Skipped entirely (not
                    truncated) when it doesn't fit. */}
                {weatherMarks.map((m, i) => {
                  if (!m.wind) return null
                  const text = m.wind.calm ? 'CALM' : m.wind.dirDeg != null ? `${m.wind.dirDeg}°/${m.wind.speedKt}` : ''
                  if (!text) return null
                  const halfW = m.wind.calm ? 3 : 18 / 2 + 4
                  const left = windXOf(m.distNm) + halfW + 4
                  if (left + text.length * 7 * 0.62 > contentW - MARGIN_R) return null
                  return (
                    <Text key={`windl-${i}`} style={[styles.windLabel, { left, top: WIND_ARROW_Y - 4 }]} numberOfLines={1}>
                      {text}
                    </Text>
                  )
                })}

                {visibleWindSamples.map((s, i) => {
                  const text = s.wind.calm ? '~CALM' : s.wind.dirDeg != null ? `~${s.wind.dirDeg}°/${s.wind.speedKt}` : ''
                  if (!text) return null
                  const halfW = s.wind.calm ? 2.5 : 13 / 2 + 3
                  const left = windXOf(s.distNm) + halfW + 4
                  if (left + text.length * 7 * 0.62 > contentW - MARGIN_R) return null
                  return (
                    <Text key={`windsamplel-${i}`} style={[styles.windLabel, { left, top: WIND_ARROW_Y - 4, opacity: 0.55 }]} numberOfLines={1}>
                      {text}
                    </Text>
                  )
                })}

                {xTicks.map((d, i) => (
                  <Text key={`xl-${i}`} style={[
                    styles.axisLabelX,
                    { left: Math.min(contentW - 20, Math.max(0, xOf(d) - 8)), top: MARGIN_T + plotH + 4 },
                  ]}>
                    {nmToDisplay(d, units.distance).toFixed(0)}
                  </Text>
                ))}
              </View>
              </View>
              </View>
              {/* Pinned Y-axis tick labels — rendered outside the scrollable
                  clip window (above) so they stay fixed at the left edge
                  regardless of scrollX, instead of scrolling away with the
                  route content like everything else in this chart does. */}
              <View style={styles.yAxisPinned} pointerEvents="none">
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
  windLabel: {
    position: 'absolute',
    color:    'rgba(148,197,255,0.85)',
    fontSize: 7,
    maxWidth: 32,
  },
  // Pinned left-edge Y-axis label column — sits above the scrollable clip
  // window (rendered after it in JSX = higher z-order) so it never scrolls
  // away with the route content. No background fill: same translucent-
  // text-over-terrain look the chart already used before scrolling existed.
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
