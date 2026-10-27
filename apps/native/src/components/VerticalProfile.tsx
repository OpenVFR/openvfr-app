/**
 * VerticalProfile — the native "Virtual Radar" vertical profile chart.
 *
 * Shows, along the planned route: terrain elevation (gradient-shaded), MSA,
 * airspace cross-sections with class/altitude labels, obstacle pictograms at
 * their true elevation, the planned altitude line (performance-based climb/
 * descent, red where below MSA), the aircraft's live position with a
 * pitch-tilted silhouette, and forward trajectory ticks.
 *
 * Built with react-native-svg. Plot geometry, axis ticks and the below-MSA
 * runs come from @open-vfr/shared/profileChart, the same module web's
 * VirtualRadar.tsx draws from. Visual design is intentionally a little
 * richer than web's: layered terrain relief shadow, real obstacle icon
 * PNGs (reusing the map's), and a pitch-responsive aircraft silhouette.
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

import React, { useEffect, useMemo, useRef, useState, useCallback, useSyncExternalStore } from 'react'
import {
  View, Text, TouchableOpacity, StyleSheet, Image, PanResponder, type LayoutChangeEvent,
} from 'react-native'
import { GestureDetector, usePanGesture, usePinchGesture, useSimultaneousGestures } from 'react-native-gesture-handler'
import Animated, { useSharedValue, useAnimatedStyle, withDecay, cancelAnimation } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import Svg, { ClipPath, Rect, Path, Line as SvgLine, Circle, Defs, LinearGradient, Stop, G, Text as SvgText } from 'react-native-svg'

import type { RouteWaypoint, LegOverride, AircraftProfileDocType } from '../types/db'
import { type Units, DEFAULT_UNITS, nmToDisplay, distLabel } from '../utils/units'
import {
  buildVirtualRadarProfile,
  applyTerrainToBands,
  projectFlightPath, plannedAltitudeLine, DEFAULT_PERF_MODEL,
  computeMsaProfile,
  corridorTerrainAlongRoute,
  legCorridorMsaFt,
  terrainForMsa,
  terrainAt,
  getMsaLookup,
  computeTrajectoryTicks,
  computeTrajectoryEndTick,
  computeVspeedTrajectory,
  trajectoryPitchDeg,
  projectWeatherMarks,
  type TerrainPoint,
  type MsaPoint,
  type AircraftPerfModel,
} from '@open-vfr/shared/virtualRadarCalc'
import { resolveMsaMargins, type MsaMargins } from '@open-vfr/shared/msaMargins'
import { legSpans, legMsaList, legBelowMsa, dragShownFt, withLegLevel, altAtY, unreachedLegs, verticalPhaseMarks, LEVEL_STEP_FT, DRAG_MIN_MOVE_PX, type LegSpan } from '@open-vfr/shared/legLevelDrag'
import { collectRoutePois, poiBaseFt } from '@open-vfr/shared/routePois'
import { obstacleSymbol, polyPath, primStyle, obstacleXScale } from '@open-vfr/shared/obstacleSymbol'
import { fetchTerrainProfileShared } from '@open-vfr/shared/terrainCache'
import { carryLookaheadTerrain } from '@open-vfr/shared/lookaheadTerrain'
import { effectiveHeight, obstacleTipsForMsa, limitingObstacleLabel, FT_PER_M } from '@open-vfr/shared/obstacleHeights'
import { useMefGrids } from '../hooks/useMefGrids'
import {
  pickWaypointLabels, waypointLabelWidth, placeLabels, placeRadarLabels, mergeNearbyLabels, obstacleLabelWidth, poiLabelWidth, OBSTACLE_LABEL_H, POI_LABEL_H,
  type BoxRect, type LabelRequest, type PlacedLabel,
} from '@open-vfr/shared/profileLabels'
import {
  symbolGroundY, LIMITING_LABEL_MERGE_PX, POI_SCALE, poiCenterY, SKY_TOP, SKY_BOTTOM, PLAN_COLOR, MSA_COLOR, GROUND_OUTLINE, CORRIDOR_FILL, CORRIDOR_OUTLINE, CORRIDOR_OUTLINE_WIDTH,
  DANGER_COLOR, DANGER_TEXT, PHASE_SHORT_COLOR, WIND_LABEL_COLOR, windAloftFit, terrainGradientStops, phaseLabelText,
  FLOWN_COLOR, FLOWN_GAP_COLOR, GROUND_COLOR, FLOWN_SPEED_COLOR, FLOWN_NEAR_FIELD_COLOR, FLOWN_NEAR_FIELD_NM,
} from '@open-vfr/shared/radarStyle'
import {
  flownAltitudeAt, flownIndexAt, flownLineParts, formatElapsed, formatUtcTime, flownGaps, flownSpeedScale, flownSpeedRuns,
  flownAirspaceAt, flownAirspaceEntries, splitBelowMsaNearFields, flownCoordinateAt, type FlownPoint, type FlownBand,
} from '@open-vfr/shared/flightLogProfile'
import { plannedAltitudesAlongTrack, type FlightLogRoute } from '@open-vfr/shared/flightLogRoute'
import { createValueStore, useStoreValue, type ValueStore } from '../utils/valueStore'
import {
  profileChartLayout, clampProfileZoom, scrollAfterZoom, profileYMax, profileYMin, liveAltitudeWindow, declutterMarks, obstacleOpacity, isLimitingObstacle, altitudeTicksFrom, formatAltitudeTick, distanceTicks, belowMsaRuns, polylinePath,
  waterBandTopFt,
} from '@open-vfr/shared/profileChart'
import { getAircraftSilhouette } from '@open-vfr/shared/aircraftSilhouette'
import { airspaceOutlines, airspaceChips, layoutAirspaceChips } from '@open-vfr/shared/airspaceOutline'
import {
  cloudLayerPaths, cloudLayerLabel, cloudGlyphHeight, cloudOpacityForOffset, cloudReportOffRouteNm,
  cloudReportIcao, cloudStripHalfWidthNm, placeCloudLabel, type LabelRect,
} from '@open-vfr/shared/cloudGlyph'
import { CLOUD_COLORS } from '@open-vfr/shared/featureColors'
import { resolveStationWeather } from '@open-vfr/shared/parseTaf'
import type { ParsedCloudLayer } from '@open-vfr/shared/fetchWx'
import { windBarbColorForSpeed, windBarbGeometry } from '@open-vfr/shared/windBarb'
import { layoutWindRow, tickLabelsClearOfWindRow, type WindRowItem } from '@open-vfr/shared/windRow'
import { useWindAloftAlongRoute } from '../hooks/useWindAloftAlongRoute'
import { usePersistedFlag } from '../utils/usePersistedFlag'
import { getTileUrls, API_BASE } from '../config'
import { getOfflineDem } from '../utils/terrainDem'
import { loadGeoJsonOnce } from '../utils/geoJsonCache'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import { Ionicons } from '@expo/vector-icons'
import type { RouteWeatherStation } from '../hooks/useWeatherAlongRoute'

// GeoJSON files are loaded once per app lifetime: see ../utils/geoJsonCache.ts.

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
  /** Abeam corridor + clearances for the MSA line (settings.msaMargins); defaults if omitted. */
  msaMargins?: Partial<MsaMargins>
  title?: string
  /** Optional content for the drag-handle row, left / right of the grip
   *  (right slot sits before the WIND toggle). Lets a caller show a compact
   *  readout (e.g. Map Ruler distance/track) inside the panel's own chrome
   *  instead of as a separate floating overlay. */
  headerStart?: React.ReactNode
  headerEnd?: React.ReactNode
  /** Renders a close (X) button at the far right of the header row, after
   *  the WIND toggle. */
  onClose?: () => void
  closeLabel?: string
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
   *  equivalent of web's pointer hover readout. */
  onHoverDistNm?: (nm: number | null) => void
  /** Enables dragging a leg up/down to change its planned level; `null` clears
   *  the leg's override (route level). Omit while route editing is locked. */
  onLegLevelChange?: (legIndex: number, altFt: number | null) => void
  /** With onLegLevelChange: only this leg's level can be dragged (in flight,
   *  the unlocked leg); undefined = every leg, null = none. */
  levelEditLeg?: number | null
  /** A tap on a leg's drawn line (in flight: unlock that leg). */
  onLegTap?: (legIndex: number) => void
  /** The chart follows the aircraft's altitude (no planned route: look-ahead). The scale is a
   *  window around the aircraft instead of fitting a plan. */
  followAircraft?: boolean
  /** Draw the band of highest ground within the abeam distance behind the ground line
   *  (default true). Off for the ruler and the look-ahead: only a planned route has a
   *  corridor the pilot set out to fly. The MSA still uses it either way. */
  corridorBand?: boolean
  /** Flight-log review: `waypoints` is the simplified recorded track and these are the
   *  recorded points along it (@open-vfr/shared/flightLogProfile). The chart then draws the
   *  flown altitude instead of a plan (no leg editing, waypoint lines or forecast winds), and
   *  an aircraft on the line can be dragged (or a spot tapped) to read time, altitude and
   *  ground speed there. Mirrors web's VirtualRadar `flown` mode. */
  flown?: FlownPoint[]
  /** Flight log: inspect the recorded point closest to this time (an event picked in the Logs list); `n` makes a repeat pick count. */
  jumpToTs?: { ts: number; n: number } | null
  /** Flight log: the route planned for it (stored with the log); its planned level is drawn
   *  faintly where the flown track ran within 2 NM of the route. */
  plannedRoute?: FlightLogRoute | null
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// DEFAULT_CHART_H = MARGIN_T + plot + MARGIN_B. The wind row lives in the
// bottom margin, under the x axis, so the top margin only needs room for
// the top tick label and the waypoint-name row.
export const DEFAULT_CHART_H  = 240
export const MIN_CHART_H      = 0
export const MAX_CHART_H      = 400
export const COLLAPSE_THRESHOLD = 24   // below this, treat as "collapsed"
const MARGIN_L  = 34   // room for FL/alt ticks
const MARGIN_R  = 10
const MARGIN_T  = 10
const MARGIN_B  = 30   // tick labels + the wind-barb row under the x axis
/** Top of the pinned Y-axis column's opaque backing: just above the top
 *  tick label (drawn at yOf(yMax) - 6 = MARGIN_T - 6). */
const AXIS_COVER_TOP = MARGIN_T - 8
// Wind row: one row of barbs just under the x axis, in the same band as the
// tick labels (METAR/TAF station barbs + ground-model barbs; see
// @open-vfr/shared/windRow for the placement rule). Offset is from the axis.
const WIND_ROW_DY = 14
const WIND_ROW_FONT = 11
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

/** Which obstacle shape a landmark kind is drawn as when it is tall enough. */
const LANDMARK_SHAPE_KIND: Record<string, string> = {
  church: 'building', mast: 'tower', chimney: 'chimney', water_tower: 'water_tower', windmill: 'tower',
}

/** A touch within this many px of a leg's drawn line starts a level drag (if it moves vertically). */
const LEG_HIT_PX = 22
/** Axis / tick label size (px). */
const AXIS_FONT = 11
/** Waypoint-name label font (px); its box is ~6.8 px per character (12 px semibold), capped. */
const WP_LABEL_FONT = 12
const wpLabelWidth = waypointLabelWidth

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

/** Roughly one distance tick per this many px of plot width. */
const X_TICK_SPACING_PX = 90


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
  opts: { strokeW?: number; shaftLen?: number; barbLen?: number; halfLen?: number; barbGap?: number; outlineOpacity?: number; opacity?: number } = {},
) {
  // Opacity goes on the leaf shapes, never on a <G> (see renderHaloText).
  const op = opts.opacity ?? 1
  const { shaft, feathers } = windBarbGeometry(speedKts, opts)
  if (!shaft) return null
  const strokeW = opts.strokeW ?? 1.6
  const outlineColor = `rgba(0,0,0,${opts.outlineOpacity ?? 0.65})`
  const outlineW = strokeW + 1.2

  const renderPass = (stroke: string, fill: string, width: number, key: string) => (
    <G key={key}>
      <SvgLine x1={shaft.x1} y1={shaft.y1} x2={shaft.x2} y2={shaft.y2} stroke={stroke} strokeWidth={width} strokeLinecap="round" opacity={op} />
      {feathers.map((f, idx) =>
        f.kind === 'line' ? (
          <SvgLine key={idx} x1={f.x1} y1={f.y1} x2={f.x2} y2={f.y2} stroke={stroke} strokeWidth={width} strokeLinecap="round" opacity={op} />
        ) : (
          <Path
            key={idx}
            d={`M${f.points[0][0]},${f.points[0][1]} L${f.points[1][0]},${f.points[1][1]} L${f.points[2][0]},${f.points[2][1]} Z`}
            fill={fill}
            opacity={op}
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
function renderHaloText(
  x: number, y: number, text: string, fill: string, fontSize: number, opacity = 1, anchor: 'start' | 'middle' | 'end' = 'start',
  opts: { weight?: '500' | '600' | '700'; halo?: number } = {},
) {
  // Opacity as stroke/fill alpha, never as `opacity` on the <G> or <Text>:
  // react-native-svg (Android) draws a group or text with opacity != 1 into
  // its own canvas-sized bitmap on every redraw (~3 MB here), and a dropped
  // group keeps that bitmap until the Java GC finalises it -- native memory
  // grew without bound during long flights.
  return (
    <G key={`${x}-${y}-${text}`}>
      <SvgText x={x} y={y} fontSize={fontSize} fontWeight={opts.weight} textAnchor={anchor} fill="none" stroke="rgba(0,0,0,0.9)" strokeOpacity={opacity} strokeWidth={opts.halo ?? 4} strokeLinejoin="round">{text}</SvgText>
      <SvgText x={x} y={y} fontSize={fontSize} fontWeight={opts.weight} textAnchor={anchor} fill={fill} fillOpacity={opacity}>{text}</SvgText>
    </G>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type LegDragState = { leg: number; startAlt: number; cand: number | null; shown: number; moved: boolean }
function createDragStore() {
  let v: LegDragState | null = null
  const subs = new Set<() => void>()
  return {
    get: () => v,
    set: (n: LegDragState | null) => { v = n; subs.forEach((f) => f()) },
    subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f) } },
  }
}

/** The live leg-drag drawing: leg frame, the previewed flight path and every leg's level. Subscribes to the drag
 *  store itself, so a drag step re-renders only this. */
function LegDragOverlay({ store, spans: legSpanList, legMsa: legMsaFt, totalNm, fallbackAltFt: legFallbackAltFt, profile, samples: pathSamples, perf, depElevFt, arrElevFt, xOf, yOf, plotH }: {
  store: ReturnType<typeof createDragStore>
  spans: LegSpan[]; legMsa: number[]; totalNm: number; fallbackAltFt: number
  profile: ReturnType<typeof buildVirtualRadarProfile>
  samples: { distNm: number }[]; perf: AircraftPerfModel | null | undefined; depElevFt: number; arrElevFt: number
  xOf: (nm: number) => number; yOf: (ft: number) => number; plotH: number
}) {
  const legDrag = useSyncExternalStore(store.subscribe, store.get)
  // The path the aircraft would fly at the dragged level (climbs and descents included).
  const dragPreviewPts = useMemo(() => {
    if (!profile || pathSamples.length === 0 || !legDrag?.moved) return null
    const level = legDrag.cand ?? legFallbackAltFt
    const alts = projectFlightPath(
      withLegLevel(profile.altitudeProfile, legDrag.leg, level), profile.totalNm, perf ?? DEFAULT_PERF_MODEL,
      pathSamples.map(p => p.distNm), depElevFt, arrElevFt,
    )
    return pathSamples.map((p, i) => ({ distNm: p.distNm, altFt: alts[i] }))
  }, [profile, pathSamples, legDrag, legFallbackAltFt, perf, depElevFt, arrElevFt])
  if (!legDrag) return null
  return (() => {
                  const yC = (ft: number) => Math.min(MARGIN_T + plotH, Math.max(MARGIN_T + 2, yOf(ft)))
                  const pv = dragPreviewPts
                  const pvD = pv && pv.length > 1 ? 'M' + pv.map(p => `${xOf(p.distNm).toFixed(1)},${yC(p.altFt).toFixed(1)}`).join(' L') : ''
                  return (
                    <G pointerEvents="none">
                      {/* Leg frame: tint on the dragged leg, a divider at each turning point, a number on every leg. */}
                      {legSpanList.map((s, i) => {
                        const x1 = xOf(s.fromNm), x2 = xOf(s.toNm), mine = legDrag.leg === i, cx = (x1 + x2) / 2
                        return (
                          <G key={`frame-${i}`}>
                            {mine && <Rect x={x1} y={MARGIN_T} width={Math.max(0, x2 - x1)} height={plotH} fill="rgba(255,255,255,0.12)" />}
                            {i > 0 && <SvgLine x1={x1} x2={x1} y1={MARGIN_T} y2={MARGIN_T + plotH} stroke="rgba(255,255,255,0.45)" strokeWidth={1} strokeDasharray="4,3" />}
                            {x2 - x1 > 22 && (
                              <>
                                <Circle cx={cx} cy={MARGIN_T + 27} r={8} fill={mine ? '#fff' : 'rgba(0,0,0,0.55)'} stroke="#fff" strokeWidth={1} />
                                {renderHaloText(cx, MARGIN_T + 31, String(i + 1), mine ? '#111' : '#fff', 10, 1, 'middle', { weight: '700', halo: mine ? 0 : 3 })}
                              </>
                            )}
                          </G>
                        )
                      })}
                      {/* Where the aircraft would fly if released now. */}
                      {pvD !== '' && (
                        <>
                          <Path d={pvD} fill="none" stroke="rgba(0,0,0,0.7)" strokeWidth={5} strokeLinejoin="round" />
                          <Path d={pvD} fill="none" stroke={PLAN_COLOR} strokeWidth={2.75} strokeLinejoin="round" />
                          {legSpanList.slice(1).map((s, i) => {
                            const near = pv!.reduce((b, p) => (Math.abs(p.distNm - s.fromNm) < Math.abs(b.distNm - s.fromNm) ? p : b), pv![0])
                            return <Circle key={`pv-turn-${i}`} cx={xOf(s.fromNm)} cy={yC(near.altFt)} r={3} fill="#2a1038" stroke="#fff" strokeWidth={1.5} />
                          })}
                        </>
                      )}
                      {/* Every leg's level, so the whole plan reads while one leg moves. */}
                      {legSpanList.map((s, i) => {
                        const x1 = xOf(s.fromNm), x2 = xOf(s.toNm), mine = legDrag.leg === i
                        if (!mine && x2 - x1 < 46) return null
                        const alt = mine ? legDrag.shown : s.altFt
                        const y = yC(alt)
                        const below = legBelowMsa(s, totalNm, alt, legMsaFt[i] ?? 0)
                        const text = (mine && legDrag.cand == null ? `release = route level (${legFallbackAltFt.toLocaleString('en-US')} ft)` : `${alt.toLocaleString('en-US')} ft`)
                          + (mine && below ? ` — below MSA ${legMsaFt[i].toLocaleString('en-US')} ft` : '')
                        return (
                          <G key={`lvl-${i}`}>
                            {mine && <SvgLine x1={x1} x2={x2} y1={y} y2={y} stroke={below ? DANGER_COLOR : '#fff'} strokeWidth={1.5} strokeDasharray="6,4" />}
                            {renderHaloText((x1 + x2) / 2, y - 8 >= MARGIN_T + 46 ? y - 8 : Math.max(y + 16, MARGIN_T + 50), text, below ? DANGER_TEXT : '#fff', mine ? 12 : 10, 1, 'middle', { weight: '700' })}
                          </G>
                        )
                      })}
                    </G>
                  )
                })()
}

/** Everything in the chart that only changes with the route, terrain, weather or scale: sky, grid, airspace,
 *  ground and clouds. Memoised so the once-a-second GPS tick and the resize drag do not rebuild (and
 *  reconcile) thousands of SVG nodes: that cost ~270 ms per render in the dev build. */
type BackdropProps = {
  profile: NonNullable<ReturnType<typeof buildVirtualRadarProfile>>
  terrainPts: TerrainPoint[]; corridorFill: string; terrainPath: { fill: string; shadow: string; outline: string }
  weatherMarks: { station: RouteWeatherStation; distNm: number; offRouteNm: number; clouds: ParsedCloudLayer[] }[]
  obstacleMarks: { labelPos?: PlacedLabel; label: string }[]; poiMarks: { labelPos?: PlacedLabel; label: string; towered?: boolean }[]
  xOf: (nm: number) => number; yOf: (ft: number) => number
  yMin: number; yMax: number; plotW: number; plotH: number; plotBottom: number; totalNm: number
  yTicks: number[]; xTicks: number[]
}
const RadarBackdrop = React.memo(function RadarBackdrop(P: BackdropProps) {
  const { profile, terrainPts, corridorFill, terrainPath, weatherMarks, obstacleMarks, poiMarks, xOf, yOf, yMin, yMax, plotW, plotH, plotBottom, totalNm, yTicks, xTicks } = P
  return (
    <>
        <Defs>
          <LinearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%"   stopColor={SKY_TOP} stopOpacity={1} />
            <Stop offset="100%" stopColor={SKY_BOTTOM} stopOpacity={1} />
          </LinearGradient>
          {/* Ground colour by elevation across the plot (a colour always means the same altitude). */}
          <LinearGradient id="terrainGrad" gradientUnits="userSpaceOnUse" x1="0" y1={MARGIN_T} x2="0" y2={plotBottom}>
            {terrainGradientStops(yMin, yMax).map((st, i) => (
              <Stop key={i} offset={`${st.offset.toFixed(1)}%`} stopColor={st.color} stopOpacity={1} />
            ))}
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

        {/* Sky: mid-tone gradient over the plot so dark and light symbols both stand out */}
        <Rect x={MARGIN_L} y={MARGIN_T} width={plotW} height={plotH} fill="url(#sky)" />

        {/* Grid: every 1000 ft (and the axis floor), and every distance tick */}
        {yTicks.filter((ft) => ft % 1000 === 0 || ft === yMin).map((ft, i) => (
          <SvgLine key={`yg-${i}`} x1={MARGIN_L} y1={yOf(ft)} x2={MARGIN_L + plotW} y2={yOf(ft)}
            stroke="rgba(255,255,255,0.22)" strokeWidth={1} strokeDasharray="3,3" />
        ))}
        {xTicks.map((d, i) => (
          <SvgLine key={`xg-${i}`} x1={xOf(d)} y1={MARGIN_T} x2={xOf(d)} y2={plotBottom}
            stroke="rgba(255,255,255,0.22)" strokeWidth={1} strokeDasharray="3,3" />
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
          const innerD = (shape.innerFloors ?? [])
            .map(([x1, y1, x2, y2]) => `M${xOf(x1)},${yOf(y1)} L${xOf(x2)},${yOf(y2)}`)
            .join(' ')
          return (
            <G key={`band-${i}`}>
              {/* Faint interior so the sky shows through; the edge band and a dark-edged border carry the shape. */}
              <Path d={fillD} fill={shape.fill} fillOpacity={0.4} fillRule="evenodd" />
              {/* Wide band hugging the inside of the edges: stroke clipped to the area */}
              <Defs><ClipPath id={`airspace-clip-${i}`}><Path d={fillD} fillRule="evenodd" /></ClipPath></Defs>
              <Path d={lineD} fill="none" stroke={shape.border} strokeOpacity={0.55} strokeWidth={12} clipPath={`url(#airspace-clip-${i})`} />
              {/* Dark outline under the border: separates it from a sky of any hue. */}
              <Path d={lineD} fill="none" stroke="rgba(0,0,0,0.75)" strokeWidth={3.5} strokeLinecap="square" />
              <Path d={lineD} fill="none" stroke={shape.border} strokeWidth={1.5} strokeLinecap="square" />
              {/* A sector's floor inside a lower sector of the same style: drawn like its side walls
                  (wide inner band only above the floor, and a solid border). */}
              {innerD !== '' && (
                <>
                  <Defs>
                    <ClipPath id={`inner-clip-${i}`}>
                      {(shape.innerFloors ?? []).map(([x1, y1, x2], k) => (
                        <Rect key={k} x={xOf(x1)} y={yOf(y1) - 20} width={xOf(x2) - xOf(x1)} height={20} />
                      ))}
                    </ClipPath>
                  </Defs>
                  <Path d={innerD} fill="none" stroke={shape.border} strokeOpacity={0.55} strokeWidth={12} clipPath={`url(#inner-clip-${i})`} />
                  <Path d={innerD} fill="none" stroke="rgba(0,0,0,0.75)" strokeWidth={3.5} strokeLinecap="square" />
                  <Path d={innerD} fill="none" stroke={shape.border} strokeWidth={1.5} strokeLinecap="square" />
                </>
              )}
            </G>
          )
        })}

        {/* ── Terrain relief shadow + fill + outline ─────────── */}
        {profile.waterCrossings.map((wc, i) => {
          const spanElevs = terrainPts
            .filter(p => p.distNm >= wc.entryNm && p.distNm <= wc.exitNm)
            .map(p => p.elevFt)
          // Null when the water is below the scale floor (live altitude window).
          const topFt = waterBandTopFt(spanElevs, yMin, yMax)
          if (topFt == null) return null
          const x1 = xOf(wc.entryNm), x2 = xOf(wc.exitNm)
          const yTop = yOf(topFt), yBot = plotBottom
          const d = `M${x1},${yTop} L${x2},${yTop} L${x2},${yBot} L${x1},${yBot} Z`
          return <Path key={`water-${i}`} d={d} fill="rgba(30,100,200,0.35)" stroke="rgba(60,140,230,0.7)" strokeWidth={1} />
        })}

        {corridorFill !== '' && (
          <Path d={corridorFill} fill={CORRIDOR_FILL} stroke={CORRIDOR_OUTLINE} strokeWidth={CORRIDOR_OUTLINE_WIDTH} />
        )}
        <Path d={terrainPath.shadow} fill="rgba(0,0,0,0.28)" />
        <Path d={terrainPath.fill} fill="url(#terrainGrad)" />
        <Path d={terrainPath.outline} fill="none" stroke={GROUND_OUTLINE} strokeWidth={1.5} />

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
          const taken: LabelRect[] = [
            ...layoutAirspaceChips(airspaceChips(profile.airspaceBands, yMax), xOf, yOf).map((p) => ({ x: p.px, y: p.py, w: p.w, h: p.h })),
            // obstacle / aerodrome names placed earlier
            ...[...obstacleMarks, ...poiMarks].filter((m) => m.labelPos && m.label).map((m) => ({
              x: m.labelPos!.left, y: m.labelPos!.baseline - 13, w: 'towered' in m ? poiLabelWidth(m.label) : obstacleLabelWidth(m.label), h: 16,
            })),
          ]
          const plotTop = MARGIN_T
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
              const y = placeCloudLabel(cx, yb, glyphH, text, taken, plotTop, plotBottom, 11 / 9)
              // Kept inside the plot at either end.
              const lx = Math.max(MARGIN_L + text.length * 3.2, Math.min(MARGIN_L + plotW - text.length * 3.2, cx))
              labels.push(
                <G key={`cloud-label-${i}-${j}`}>
                  {renderHaloText(lx, y, text, accent ?? CLOUD_COLORS.label, 11, opacity, 'middle')}
                </G>,
              )
            })
          })
          return <>{shapes}{labels}</>
        })()}
    </>
  )
}, (a, b) => {
  const keys: (keyof BackdropProps)[] = ['profile', 'terrainPts', 'corridorFill', 'terrainPath', 'weatherMarks', 'obstacleMarks', 'poiMarks', 'xOf', 'yOf', 'yMin', 'yMax', 'plotW', 'plotH', 'plotBottom', 'totalNm']
  return keys.every((k) => a[k] === b[k]) && a.yTicks.join() === b.yTicks.join() && a.xTicks.join() === b.xTicks.join()
})

/** Planned line, turn points, MSA, wind barbs, chips and waypoint ticks inside the chart Svg. Independent of the aircraft position, memoized so a position tick does not rebuild ~hundreds of Svg elements; keep its props stable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ProfileAStatic = React.memo(function ProfileAStatic({
  xTicks,
  logMode,
  flownDraw,
  showSpeed,
  flownPlannedPath,
  arrElevFt,
  contentW,
  depElevFt,
  dragStore,
  dragging,
  legFallbackAltFt,
  legMsaFt,
  legSpanList,
  msaPath,
  obstacleMarks,
  pathSamples,
  perf,
  phaseLayout,
  phaseMarks,
  plannedAltAt,
  plannedPath,
  plotH,
  plotW,
  poiMarks,
  profile,
  projDangerPath,
  showMsa,
  totalNm,
  unreached,
  windAloft,
  windRow,
  windXOf,
  xOf,
  yMax,
  yMin,
  yOf,
}: any) {
  return (
    <>
                {/* ── Planned altitude line (dark outline under it), clipped to the plot ── */}
                <Defs><ClipPath id="plan-clip"><Rect x={MARGIN_L} y={MARGIN_T} width={plotW} height={plotH + 4} /></ClipPath></Defs>
                {/* Flight log: ground speed on its own scale (0 at the plot bottom), under the altitude line. */}
                {flownDraw && showSpeed && flownDraw.speed !== '' && (
                  <Path d={flownDraw.speed} clipPath="url(#plan-clip)" fill="none" stroke={FLOWN_SPEED_COLOR} strokeWidth={1.5} strokeDasharray="5,3" opacity={0.85} />
                )}
                {/* Flight log: the planned level (route stored with the log), faint and dashed. */}
                {flownPlannedPath ? (
                  <Path d={flownPlannedPath} clipPath="url(#plan-clip)" fill="none" stroke={PLAN_COLOR} strokeOpacity={0.55} strokeWidth={2} strokeDasharray="7,4" />
                ) : null}
                {/* Flight log: the recorded altitude instead of a plan. */}
                {flownDraw && flownDraw.runs !== '' && (
                  <>
                    <Path d={flownDraw.runs} clipPath="url(#plan-clip)" fill="none" stroke="rgba(0,0,0,0.7)" strokeWidth={5} strokeLinejoin="round" />
                    <Path d={flownDraw.runs} clipPath="url(#plan-clip)" fill="none" stroke={FLOWN_COLOR} strokeWidth={2.75} strokeLinejoin="round" />
                  </>
                )}
                {!logMode && (<>
                <Path d={plannedPath} clipPath="url(#plan-clip)" fill="none" stroke="rgba(0,0,0,0.7)" strokeWidth={5} strokeLinejoin="round" opacity={dragging ? 0.18 : 1} />
                <Path d={plannedPath} clipPath="url(#plan-clip)" fill="none" stroke={PLAN_COLOR} strokeWidth={2.75} strokeLinejoin="round" opacity={dragging ? 0.18 : 1} />
                {/* Turn points: white dots with a dark rim where one leg ends and the next begins. */}
                {!dragging && legSpanList.slice(1).map((sp: any, i: any) => {
                  const alt = plannedAltAt(sp.fromNm)
                  if (alt == null || alt > yMax || alt < yMin) return null
                  if (phaseMarks.some((m: any) => Math.abs(m.distNm - sp.fromNm) < 0.3 && Math.abs(m.altFt - alt) < 150)) return null
                  return <Circle key={`turn-${i}`} cx={xOf(sp.fromNm)} cy={yOf(alt)} r={2.75} fill="#2a1038" stroke="#fff" strokeWidth={1.5} />
                })}
                {/* A requested level the drawn path never reaches: dashed at that level. */}
                {unreached.map((u: any) => {
                  const s = legSpanList[u.legIndex]
                  if (!s) return null
                  // A level above the chart top is pinned to the top edge, labelled with its value, so it is never silently absent.
                  const above = u.levelFt > yMax
                  const y = Math.max(MARGIN_T + 2, yOf(u.levelFt))
                  const x1 = xOf(s.fromNm), x2 = xOf(s.toNm)
                  return (
                    <G key={`unreached-${u.legIndex}`} pointerEvents="none">
                      <SvgLine x1={x1} x2={x2} y1={y} y2={y} stroke={PLAN_COLOR} strokeWidth={1.5} strokeDasharray="6,4" opacity={0.75} />
                      {above && !dragging && x2 - x1 > 70 && renderHaloText((x1 + x2) / 2, MARGIN_T + 46, `\u25b2 ${u.levelFt.toLocaleString('en-US')} ft set`, '#fff', 10, 1, 'middle', { weight: '700', halo: 3 })}
                    </G>
                  )
                })}
                {/* Top of climb / top of descent on the flown path (amber, with the level set, when a climb falls short). */}
                {!dragging && phaseLayout.map((p: any, k: any) => (
                  <G key={`phase-${k}`}>
                    <Circle cx={p.x} cy={p.y} r={3.5} fill="#fff" stroke="#000" strokeWidth={1.25} />
                    {p.pl && renderHaloText(p.pl.left, p.pl.baseline, p.text, p.short ? PHASE_SHORT_COLOR : '#fff', 11, 1, 'start', { weight: '700' })}
                  </G>
                ))}
                </>)}

                {/* ── MSA dashed line (dark underlay), after the plan so it stays visible ── */}
                {showMsa && msaPath !== '' && <Path d={msaPath} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth={3.5} />}
                {showMsa && msaPath !== '' && <Path d={msaPath} fill="none" stroke={MSA_COLOR} strokeWidth={1.75} strokeDasharray="6,3" />}

                {dragging && (
                  <LegDragOverlay
                    store={dragStore} spans={legSpanList} legMsa={legMsaFt} totalNm={totalNm} fallbackAltFt={legFallbackAltFt}
                    profile={profile} samples={pathSamples} perf={perf} depElevFt={depElevFt} arrElevFt={arrElevFt}
                    xOf={xOf} yOf={yOf} plotH={plotH}
                  />
                )}

                {/* Winds aloft: barbs at each standard pressure level's nominal
                    altitude (model forecast), mirrors web's VirtualRadar. */}
                {(() => {
                  const chipBoxes: BoxRect[] = layoutAirspaceChips(airspaceChips(profile.airspaceBands, yMax), xOf, yOf)
                    .map((c) => ({ left: c.px, right: c.px + c.w, top: c.py, bottom: c.py + c.h }))
                  return windAloft.flatMap((col: any, ci: any) => col.levels.map((lv: any) => {
                  // Surface (10 m) wind is part of the wind row under the x axis.
                  if (lv.surface || lv.altFt > yMax * 0.96 || lv.altFt < yMin) return null
                  const x = windXOf(col.distNm), y = yOf(lv.altFt)
                  const color = windBarbColorForSpeed(lv.speedKts)
                  const label = lv.speedKts === 0 ? 'CALM' : `${String(lv.dirDeg).padStart(3, '0')}°/${lv.speedKts}`
                  // Label right, else left, else barb only; clear of the airspace chips and the plot edges.
                  const fit = windAloftFit(x, y, Math.ceil(label.length * 11 * 0.65), chipBoxes, { left: MARGIN_L, right: contentW - MARGIN_R }, 12)
                  if (!fit.barb) return null
                  return (
                    <G key={`windaloft-${ci}-${lv.altFt}`}>
                      {lv.speedKts === 0
                        ? <Circle cx={x} cy={y} r={3} fill="none" stroke="rgba(148,163,184,0.8)" strokeWidth={1} />
                        : (
                          <G transform={`translate(${x},${y}) rotate(${lv.dirDeg}) translate(0, 8)`}>
                            {renderWindBarbShape(lv.speedKts, color, { shaftLen: 16, barbLen: 7, halfLen: 4, barbGap: 4, strokeW: 1.5 })}
                          </G>
                        )}
                      {fit.label === 'right' && renderHaloText(x + 12, y + 4, label, WIND_LABEL_COLOR, 11, 1, 'start', { weight: '600' })}
                      {fit.label === 'left' && renderHaloText(x - 12, y + 4, label, WIND_LABEL_COLOR, 11, 1, 'end', { weight: '600' })}
                    </G>
                  )
                  }))
                })()}

                {/* ── Below-MSA stretches of the planned line ─────────── */}
                {!dragging && !logMode && projDangerPath && (
                  <Path d={projDangerPath} fill="none" stroke={DANGER_COLOR} strokeWidth={2.5} />
                )}
                {flownDraw && flownDraw.below !== '' && (
                  <Path d={flownDraw.below} fill="none" stroke={DANGER_COLOR} strokeWidth={2.5} />
                )}
                {flownDraw && flownDraw.belowNear !== '' && (
                  <Path d={flownDraw.belowNear} fill="none" stroke={FLOWN_NEAR_FIELD_COLOR} strokeWidth={2.5} />
                )}
                {/* Recording gaps: nothing known in between, so a dashed bridge and a dot at each end. */}
                {flownDraw?.gaps.map((g: { x1: number; y1: number; x2: number; y2: number }, i: number) => (
                  <G key={`gap-${i}`}>
                    <SvgLine x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke={FLOWN_GAP_COLOR} strokeWidth={2} strokeDasharray="3,3" />
                    <Circle cx={g.x1} cy={g.y1} r={3.5} fill={FLOWN_GAP_COLOR} stroke="#000" strokeWidth={1} />
                    <Circle cx={g.x2} cy={g.y2} r={3.5} fill={FLOWN_GAP_COLOR} stroke="#000" strokeWidth={1} />
                  </G>
                ))}

                {/* ── Labels on top of every line (plan, MSA, below-MSA): chips, then obstacle / aerodrome names ── */}
                {/* Label chips: class letter (or designator) + first radio
                    frequency, laid out so neighbouring sectors' chips never
                    cover each other (see layoutAirspaceChips). */}
                {layoutAirspaceChips(airspaceChips(profile.airspaceBands, yMax), xOf, yOf).map((p, i) => {
                  const { chip: c, px: x, py: y, tagW, freqW, w, h } = p
                  return (
                    <G key={`chip-${i}`}>
                      <Rect x={x} y={y} width={w} height={h} fill="#fff" stroke={c.border} strokeWidth={1} rx={1.5} />
                      <Rect x={x} y={y} width={tagW} height={h} fill={c.border} rx={1.5} />
                      <SvgText x={x + tagW / 2} y={y + 10.5} textAnchor="middle" fontSize={9.5} fontWeight="700" fill="#fff">{c.tag}</SvgText>
                      {p.showFreq ? <SvgText x={x + tagW + freqW / 2} y={y + 10.5} textAnchor="middle" fontSize={9.5} fontWeight="600" fill="#111">{c.freq}</SvgText> : null}
                    </G>
                  )
                })}

                {obstacleMarks.filter((m: any) => m.labelPos && m.leader).map((m: any) => (
                  <SvgLine key={`lead-${m.key}`} x1={m.cx} y1={m.cy - 4} x2={m.cx} y2={m.labelPos!.baseline + 3}
                    stroke={DANGER_TEXT} strokeWidth={1} strokeDasharray="2,2" opacity={0.8} />
                ))}
                {obstacleMarks.filter((m: any) => m.labelPos).map((m: any) => (
                  <G key={`lim-${m.key}`}>{renderHaloText(m.labelPos!.left, m.labelPos!.baseline, m.label, DANGER_TEXT, 12, 1, 'start', { weight: '700' })}</G>
                ))}
                {poiMarks.filter((m: any) => m.labelPos).map((m: any) => (
                  <G key={`poi-label-${m.key}`}>{renderHaloText(m.labelPos!.left, m.labelPos!.baseline, m.label, '#fff', 11, 1, 'start', { weight: m.kind === 'aerodrome' ? '700' : '500' })}</G>
                ))}

                {/* Wind row under the x axis (see windRow above). */}
                {windRow.barbs.map((w: any) => {
                  const x = w.px, y = MARGIN_T + plotH + WIND_ROW_DY
                  if (w.wind.dirDeg == null && !w.wind.calm) {
                    return <Circle key={`windrow-${w.key}`} cx={x} cy={y} r={3} fill="none" stroke="rgba(250,204,21,0.7)" strokeWidth={1} strokeDasharray="1.5,1.5" />
                  }
                  const color = w.wind.calm ? 'rgba(203,213,225,0.95)' : windBarbColorForSpeed(w.wind.speedKt)
                  return (
                    <G key={`windrow-${w.key}`}>
                      {w.wind.calm
                        ? <Circle cx={x} cy={y} r={3} fill="none" stroke="rgba(148,163,184,0.8)" strokeWidth={1} opacity={w.model ? 0.85 : 1} />
                        : (
                          // dirDeg is the meteorological FROM bearing; the shaft
                          // points FROM. Rotation is re-centred on the shaft's
                          // midpoint so the glyph stays balanced about y.
                          <G transform={`translate(${x},${y}) rotate(${w.wind.dirDeg}) translate(0, ${WIND_BARB_SHAFT_LEN / 2})`}>
                            {renderWindBarbShape(w.wind.speedKt, color, { shaftLen: WIND_BARB_SHAFT_LEN, barbLen: WIND_BARB_BARB_LEN, halfLen: WIND_BARB_HALF_LEN, barbGap: WIND_BARB_BARB_GAP, strokeW: WIND_BARB_STROKE_W, opacity: w.model ? 0.85 : 1 })}
                          </G>
                        )}
                      {w.label === 'right' && renderHaloText(x + 9 + 4, y + 3, w.text, color, WIND_ROW_FONT, w.model ? 0.85 : 1, 'start')}
                      {w.label === 'left' && renderHaloText(x - 9 - 4, y + 3, w.text, color, WIND_ROW_FONT, w.model ? 0.85 : 1, 'end')}
                    </G>
                  )
                })}

                {/* ── Waypoint ticks ──────────────────────────────────── */}
                {/* (A flight log's path vertices are simplification points, not waypoints.) */}
                {!logMode && profile.waypointTicks.map((tick: any, i: any) => i === 0 ? null : (
                  <SvgLine key={`wp-${i}`} x1={xOf(tick.distNm)} y1={MARGIN_T} x2={xOf(tick.distNm)} y2={MARGIN_T + plotH}
                    stroke="rgba(255,255,255,0.16)" strokeWidth={1} />
                ))}

                {/* ── X-axis distance ticks ────────────────────────────── */}
                {xTicks.map((d: number, i: number) => (
                  <SvgLine key={`xt-${i}`} x1={xOf(d)} y1={MARGIN_T + plotH} x2={xOf(d)} y2={MARGIN_T + plotH + 3}
                    stroke="rgba(255,255,255,0.25)" strokeWidth={1} />
                ))}
    </>
  )
})


/** Obstacle / landmark icons and waypoint text (first part of the RN overlay). Position independent, memoized; keep props stable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ProfileCStatic = React.memo(function ProfileCStatic({
  chartH,
  contentW,
  landmarkMarks,
  obstacleMarks,
  poiMarks,
  profile,
  styles,
  totalNm,
  visibleWaypointTicks,
  xOf,
  yMax,
  yOf,
}: any) {
  return (
    <>
                {obstacleMarks.map((m: any) => {
                  const icon = OBSTACLE_ICONS[m.kind] ?? OBSTACLE_ICON_FALLBACK
                  const size = 22
                  if (!m.full) {
                    // Crowded: a dot at the tip, so a field of masts does not
                    // turn into overlapping pictograms.
                    return <View key={m.key} style={{ position: 'absolute', width: 4, height: 4, borderRadius: 2, backgroundColor: 'rgba(220,80,60,0.9)', opacity: m.opacity, left: m.cx - 2, top: m.cy - 2 }} />
                  }
                  // Tall enough: drawn in the single shape layer below.
                  if (m.shape) return null
                  return (
                    // Anchor by BOTTOM edge at the tip point, growing
                    // UPWARD from it -- a top-anchor's fixed pixel height
                    // extends DOWNWARD from tipFt instead, which for a
                    // short/zero-height obstacle (tipFt near baseFt, itself
                    // near the chart floor) has nowhere to go but below true
                    // 0ft/ground -- same failure mode as the original
                    // center-anchor bug, just via a different path. Mirrors
                    // web's identical fix.
                    <View key={m.key} style={{ position: 'absolute', left: 0, top: 0, opacity: m.opacity }} pointerEvents="none">
                      {m.groundY - m.cy > 4 && (
                        <>
                          <View style={{ position: 'absolute', width: 1.5, left: m.cx - 0.75, top: m.cy, height: m.groundY - m.cy, backgroundColor: 'rgba(220,80,60,0.85)' }} />
                          <View style={{ position: 'absolute', width: 4, height: 4, borderRadius: 2, left: m.cx - 2, top: m.groundY - 2, backgroundColor: 'rgba(220,80,60,0.95)' }} />
                        </>
                      )}
                      <Image
                        source={icon}
                        style={{ position: 'absolute', width: size, height: size, left: m.cx - size / 2, top: m.cy - size }}
                        resizeMode="contain"
                      />
                    </View>
                  )
                })}

                {landmarkMarks.map((m: any) => {
                  const icon = LANDMARK_ICONS[m.kind] ?? LANDMARK_ICON_FALLBACK
                  const size = 14
                  if (m.shape) return null   // drawn in the shape layer below
                  if (!m.full) {
                    return <View key={m.key} style={{ position: 'absolute', width: 3, height: 3, borderRadius: 1.5, backgroundColor: 'rgba(150,150,150,0.8)', left: m.cx - 1.5, top: m.cy - 3 }} />
                  }
                  return (
                    // Anchor by BOTTOM edge, not center -- m.cy is ground.
                    <Image
                      key={m.key}
                      source={icon}
                      style={{ position: 'absolute', width: size, height: size, left: m.cx - size / 2, top: m.cy - size }}
                      resizeMode="contain"
                    />
                  )
                })}

                {/* Full-height shapes of obstacles and landmarks (ground to tip), then the aerodrome /
                    navaid / reporting-point symbols, one layer. Dashed = height is an assumption, not data.
                    Obstacle shapes are widened (not heightened: height is data) for legibility. */}
                <Svg width={contentW} height={chartH} style={{ position: 'absolute', left: 0, top: 0 }} pointerEvents="none">
                  {[...landmarkMarks.map((m: any) => ({ ...m, opacity: m.estimated ? 0.85 : 1, scaleX: 1 })), ...obstacleMarks.map((m: any) => ({ ...m, scaleX: obstacleXScale(m.kind) }))].map((m) => m.shape ? (
                    // Opacity on each shape, not on a <G> (see renderHaloText).
                    <G key={`shape-${m.key}`}>
                      <G transform={`translate(${m.cx} 0) scale(${m.scaleX} 1) translate(${-m.cx} 0)`}>
                        {m.shape.map((p: any, k: any) => {
                          const op = m.opacity ?? 1
                          if (p.t === 'rect') {
                            const st = primStyle(p)
                            return <Rect key={k} x={p.x} y={p.y} width={p.w} height={p.h} fill={st.fill} fillOpacity={st.fillOpacity} stroke={st.stroke} strokeWidth={1} opacity={op} />
                          }
                          if (p.t === 'poly') {
                            const st = primStyle(p)
                            return <Path key={k} d={polyPath(p.pts)} fill={st.fill} fillOpacity={st.fillOpacity} stroke={st.stroke} strokeWidth={1} opacity={op} />
                          }
                          if (p.t === 'line') return <SvgLine key={k} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke={p.stroke} strokeWidth={p.w} strokeLinecap="round" opacity={op} />
                          return <Circle key={k} cx={p.cx} cy={p.cy} r={p.r} fill={p.fill} opacity={op} />
                        })}
                      </G>
                    </G>
                  ) : null)}
                  {poiMarks.map((m: any) => (
                    <G key={m.key} transform={`translate(${m.cx} ${m.cy}) scale(${POI_SCALE}) translate(${-m.cx} ${-m.cy})`}>
                      {/* dark halo pass under the coloured symbol, so it holds up on any sky or ground */}
                      {[true, false].map((halo) => {
                        const stroke = halo ? 'rgba(0,0,0,0.8)' : '#fff'
                        const sw = halo ? 4 : 1.25
                        const col = (c: string) => (halo ? 'rgba(0,0,0,0.8)' : c)
                        return (
                          <G key={halo ? 'h' : 'm'}>
                            {m.kind === 'aerodrome' && (m.subtype === 'HP'
                              ? <Rect x={m.cx - 4} y={m.cy - 4} width={8} height={8} rx={1.5} fill={col('#f472b6')} stroke={stroke} strokeWidth={sw} />
                              : <Circle cx={m.cx} cy={m.cy} r={5} fill={col(m.towered ? '#c084fc' : '#60a5fa')} stroke={stroke} strokeWidth={sw} />)}
                            {m.kind === 'navaid' && <Path d={`M${m.cx},${m.cy - 5} L${m.cx + 5},${m.cy} L${m.cx},${m.cy + 5} L${m.cx - 5},${m.cy} Z`} fill={col('#34d399')} stroke={stroke} strokeWidth={sw} />}
                            {m.kind === 'reporting' && <Path d={`M${m.cx},${m.cy - 5} L${m.cx + 4.5},${m.cy + 3} L${m.cx - 4.5},${m.cy + 3} Z`} fill={col('#facc15')} stroke={stroke} strokeWidth={sw} />}
                          </G>
                        )
                      })}
                    </G>
                  ))}
                </Svg>

                {/* Renders visibleWaypointTicks (collision-filtered above),
                    not the raw profile.waypointTicks list -- see the memo
                    comment near windXOf. */}
                {(() => {
                  // A label that would sit on an airspace chip drops below it
                  // (chips can reach the plot's top edge, where the
                  // waypoint-name row lives).
                  const chips = layoutAirspaceChips(airspaceChips(profile.airspaceBands, yMax), xOf, yOf)
                  const WP_LABEL_H = 12
                  return visibleWaypointTicks.map((tick: any) => {
                    // Clamp so the destination's label (sitting exactly at the
                    // right edge of the *content* — not the panel, since this
                    // whole overlay scrolls with the Svg — doesn't overflow
                    // past contentW and get clipped to just its first letter.
                    const w = wpLabelWidth(tick.name)
                    const left = Math.max(0, Math.min(xOf(totalNm) - w - 2, xOf(tick.distNm) + 2))
                    const nearRight = xOf(tick.distNm) + 2 + w > xOf(totalNm) - 2
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
                        // Near the plot's right edge the label is anchored by its RIGHT edge:
                        // whatever width the text really renders at, it ends inside the plot.
                        style={[styles.wpLabel, nearRight ? { right: contentW - xOf(totalNm) + 2, top, maxWidth: w } : { left, top, maxWidth: w }]}
                        numberOfLines={1}
                      >
                        {tick.name}
                      </Text>
                    )
                  })
                })()}

    </>
  )
})


/** Wind-barb and x-axis tick text (last part of the RN overlay). Position independent, memoized; keep props stable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ProfileDStatic = React.memo(function ProfileDStatic({
  contentW,
  plotH,
  styles,
  units,
  windRow,
  xOf,
  xTicks,
}: any) {
  return (
    <>
                {/* No dir/speed text label alongside the barb -- see the
                    map's identical fix (AviationMap.tsx's removed
                    'wind-arrows-label' layer): the barb shape itself
                    (feather count + speed-tiered colour) already carries
                    the at-a-glance strength read, and a tiny permanent
                    text label at this chart's scale was flagged as
                    illegible in a pre-release pass. */}


                {xTicks.map((d: any, i: any) => {
                  if (!windRow.tickLabelShown[i]) return null
                  // Centres the label under its tick mark by actual text
                  // width instead of a fixed -8px offset -- that assumed
                  // every number was ~2 digits wide, so single-digit ticks
                  // ("0", "6") sat visibly off-centre from the tick line
                  // above them, more so after the fontSize bump widened
                  // the fixed-offset error further. Same char-width*
                  // fontSize*0.62 estimate used elsewhere in this chart
                  // (e.g. the wind labels), halved for a center offset.
                  const label = nmToDisplay(d, units.distance).toFixed(0)
                  const halfW = label.length * AXIS_FONT * 0.31
                  return (
                    <Text key={`xl-${i}`} style={[
                      styles.axisLabelX,
                      // Floor at MARGIN_L, not 0: left of it is the pinned
                      // axis column, which would cover part of the "0" label.
                      { left: Math.min(contentW - 20, Math.max(MARGIN_L, xOf(d) - halfW)), top: MARGIN_T + plotH + 3 },
                    ]}>
                      {label}
                    </Text>
                  )
                })}
    </>
  )
})


const NO_SAMPLES: TerrainPoint[] = []
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NO_WAYPOINT_TICKS: any[] = []

/** Keeps the previous array while the numbers are unchanged, so memoized children see a stable prop. */
function useStableList(next: number[]): number[] {
  const ref = useRef(next)
  if (ref.current.length !== next.length || ref.current.some((v, i) => v !== next[i])) ref.current = next
  return ref.current
}

// ---------------------------------------------------------------------------
// Flight-log inspection (flown mode)
// ---------------------------------------------------------------------------

/** Inspected recorded point; `touched` = the user has moved it (the map marker starts then). */
type FlownInspect = { idx: number; touched: boolean }
/** Grab radius around the flight-log aircraft (px): a touch starting inside it scrubs, not pans. */
const FLOWN_HANDLE_R = 30
/** While scrubbing, a finger this close to a chart edge (px) scrolls the chart along. */
const FLOWN_EDGE_PX = 36
const FLOWN_EDGE_STEP_PX = 12
const FLOWN_TAP_SLOP_PX = 8
const FLOWN_TAP_MAX_MS = 350
/** Route chart that scrolls: holding a finger still this long (ms) starts scrubbing instead of panning. */
const ROUTE_HOLD_MS = 300

/** The aircraft on the flown line at the inspected point (content coordinates, scrolls with the chart).
 *  Also publishes its position to the gesture worklet, which decides whether a touch grabbed it.
 *  A small fixed Svg in a View moved with a transform: moving it never re-rasterises an Svg
 *  (see AGENTS.md, "an <Svg> that changes per tick must be small"). */
function FlownAircraft({ store, flown, xOf, yOf, yMin, yMax, silhouette, acX, acY }: {
  store: ValueStore<FlownInspect>
  flown: FlownPoint[]
  xOf: (nm: number) => number
  yOf: (ft: number) => number
  yMin: number
  yMax: number
  silhouette: ReturnType<typeof getAircraftSilhouette>
  acX: { value: number }
  acY: { value: number }
}) {
  const { idx } = useStoreValue(store)
  const p = flown[idx]
  const alt = p ? flownAltitudeAt(flown, p.distNm) : NaN
  const x = p ? xOf(p.distNm) : -1000
  const y = Number.isFinite(alt) ? yOf(Math.max(yMin, Math.min(yMax, alt))) : MARGIN_T + 20
  useEffect(() => { acX.value = x; acY.value = y }, [x, y, acX, acY])
  if (!p) return null
  const R = FLOWN_AIRCRAFT_BOX / 2
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: FLOWN_AIRCRAFT_BOX, height: FLOWN_AIRCRAFT_BOX, transform: [{ translateX: Math.round(x - R) }, { translateY: Math.round(y - R) }] }}>
      <FlownAircraftGlyph silhouette={silhouette} />
    </View>
  )
}

const FLOWN_AIRCRAFT_BOX = 40

/** The glyph itself: identical props while dragging, so its Svg is drawn once. */
const FlownAircraftGlyph = React.memo(function FlownAircraftGlyph({ silhouette }: { silhouette: ReturnType<typeof getAircraftSilhouette> }) {
  const R = FLOWN_AIRCRAFT_BOX / 2
  return (
    <Svg width={FLOWN_AIRCRAFT_BOX} height={FLOWN_AIRCRAFT_BOX}>
      <G transform={`translate(${R}, ${R})`}>
        {/* Finger-sized grab target; the dashed ring shows it can be picked up. */}
        <Circle r={18} fill="#ffffff" fillOpacity={0.1} stroke="#ffffff" strokeOpacity={0.55} strokeWidth={1} strokeDasharray="3,3" />
        {silhouette.map((part, i) => (
          <Path key={`fa-${i}`} d={part.d} fill={part.fill ?? '#ffffff'} fillOpacity={part.opacity} stroke="#000000" strokeOpacity={0.7} strokeWidth={0.6} />
        ))}
      </G>
    </Svg>
  )
})

/** Readout of the inspected point, at the top of the chart viewport on the side away from the
 *  aircraft (it covered the aircraft and the end of the line when fixed to the right). */
function FlownReadout({ store, flown, bands, terrainPts, getMsa, styles, xOf, scrollXRef, viewportW, planned }: {
  store: ValueStore<FlownInspect>
  flown: FlownPoint[]
  bands: FlownBand[]
  xOf: (nm: number) => number
  scrollXRef: { current: number }
  viewportW: number
  /** Planned level per terrain sample (route stored with the log); null off the route. */
  planned?: { alts: (number | null)[]; distNms: number[] } | null
  terrainPts: TerrainPoint[]
  getMsa: (nm: number) => number
  styles: ReturnType<typeof makeStyles>
}) {
  const { idx, touched } = useStoreValue(store)
  const p = flown[idx]
  const aircraftOnRight = !!p && xOf(p.distNm) - scrollXRef.current > viewportW / 2
  // A full-width row with the box aligned to one end (switching absolute left/right offsets
  // left a stale offset behind on Fabric, stretching the box across the chart).
  const rowStyle = [styles.flownReadoutRow, { justifyContent: aircraftOnRight ? 'flex-start' as const : 'flex-end' as const }]
  if (!touched || !p) {
    return (
      <View style={rowStyle} pointerEvents="none">
        <View style={styles.flownReadout}>
          <Text style={styles.flownHint}>Drag the aircraft, or tap the chart, to inspect</Text>
        </View>
      </View>
    )
  }
  const altKnown = Number.isFinite(p.altFt)
  const msa = getMsa(p.distNm)
  const rows: { label: string; value: string; color?: string }[] = [
    { label: 'TIME', value: formatElapsed(p.elapsedMs) },
    { label: 'UTC', value: formatUtcTime(p.ts) },
    { label: 'ALT', value: altKnown ? `${Math.round(p.altFt)} ft` : '\u2014', color: FLOWN_COLOR },
    { label: 'GS', value: Number.isFinite(p.spdKts) ? `${Math.round(p.spdKts)} kt` : '\u2014', color: FLOWN_SPEED_COLOR },
  ]
  if (altKnown && terrainPts.length > 0) rows.push({ label: 'AGL', value: `${Math.round(p.altFt - terrainAt(terrainPts, p.distNm))} ft`, color: GROUND_COLOR })
  if (msa > 0) rows.push({ label: 'MSA', value: `${Math.round(msa)} ft`, color: altKnown && p.altFt < msa ? DANGER_TEXT : MSA_COLOR })
  if (planned && planned.distNms.length > 0) {
    let k = 0
    for (let j = 1; j < planned.distNms.length; j++) if (Math.abs(planned.distNms[j] - p.distNm) < Math.abs(planned.distNms[k] - p.distNm)) k = j
    const plan = planned.alts[k]
    if (plan != null) rows.push({ label: 'PLAN', value: `${Math.round(plan)} ft`, color: PLAN_COLOR })
  }
  // Airspace the aircraft was in (limits as drawn: for review, not proof of an infringement).
  for (const b of altKnown ? flownAirspaceAt(bands, p.distNm, p.altFt).slice(0, 2) : []) rows.push({ label: b.class, value: b.name })
  return (
    <View style={rowStyle} pointerEvents="none">
      <View style={styles.flownReadout}>
        {rows.map((r) => (
          <View key={r.label} style={styles.flownRow}>
            <Text style={[styles.flownLabel, r.color ? { color: r.color } : null]}>{r.label}</Text>
            <Text style={styles.flownValue}>{r.value}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}

export function VerticalProfile({
  waypoints, legOverrides, units = DEFAULT_UNITS, airspaceCeilingFt, msaMargins, title, headerStart, headerEnd, onClose, closeLabel, aircraftProfile,
  currentDistNm, currentAltFt, currentSpeedKts, currentVSpeedFpm, trajectoryMode, trajectoryNm = 5,
  crossTrackNm, weatherStations,
  height = DEFAULT_CHART_H, onHeightChange, onHoverDistNm, onLegLevelChange, levelEditLeg, onLegTap, followAircraft, corridorBand = true,
  flown, jumpToTs, plannedRoute,
}: Props) {
  const styles = useThemedStyles(makeStyles)
  const logMode = flown != null
  // Flight log: the inspected recorded point (starts mid-flight, untouched) in a store, so moving
  // it re-renders only the aircraft and the readout, not the whole chart.
  const flownStore = useMemo(
    () => createValueStore<FlownInspect>({ idx: flown ? flownIndexAt(flown, (flown[flown.length - 1]?.distNm ?? 0) / 2) : 0, touched: false }),
    [flown],
  )
  const flownRef = useRef(flown); flownRef.current = flown
  const flownModeSV = useSharedValue(logMode)
  useEffect(() => { flownModeSV.value = logMode }, [logMode, flownModeSV])
  const acXSV = useSharedValue(-1000)
  const acYSV = useSharedValue(-1000)
  const flownScrubSV = useSharedValue(0)
  // Route chart wider than the panel: 0 undecided, 1 scrubbing (after a short hold), 2 panning.
  const routeScrubSV = useSharedValue(0)
  const flownMoveSV = useSharedValue(0)
  const flownBeginSV = useSharedValue({ t: 0, x: 0 })
  const chartWSV = useSharedValue(0)
  const [airspaceGeo, setAirspaceGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [obstacleGeo, setObstacleGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [landmarkGeo, setLandmarkGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  // Aerodromes, reporting points and navaids along the route (own distances per kind).
  const [poiSets, setPoiSets] = useState<{ aerodromes: GeoJSON.FeatureCollection | null; reporting: GeoJSON.FeatureCollection | null; navaids: GeoJSON.FeatureCollection | null }>({ aerodromes: null, reporting: null, navaids: null })
  const [terrainPts, setTerrainPts]   = useState<TerrainPoint[]>([])
  // True when neither the elevation API nor the offline DEM could supply
  // terrain for this route: the chart then has no ground, MSA or AGL lift.
  const [terrainFailed, setTerrainFailed] = useState(false)
  const [showWindAloft, setShowWindAloft] = usePersistedFlag('ovfr:vr:wind', true)
  // The MSA line (below-MSA stretches in red stay on either way).
  const [showMsa, setShowMsa] = usePersistedFlag('ovfr:vr:msa', true)
  // Obstacle labels (short tip altitude / name beside each limiting obstacle); the symbols stay either way.
  const [showObstLabels, setShowObstLabels] = usePersistedFlag('ovfr:vr:obst', true)
  // Flight log: the ground-speed line (own scale; exact values in the readout either way).
  const [showSpeed, setShowSpeed] = usePersistedFlag('ovfr:vr:gs', true)
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
    // Only claim a touch that began on a header button (ruler clear, WIND)
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
    {
      const none = () => null
      Promise.all([
        loadGeoJsonOnce(getTileUrls().aerodromes).catch(none),
        loadGeoJsonOnce(getTileUrls().waypoints).catch(none),
        loadGeoJsonOnce(getTileUrls().navaids).catch(none),
      ]).then(([aerodromes, reporting, navaids]) => setPoiSets({ aerodromes, reporting, navaids }))
    }
  }, [])

  // Fetch terrain profile whenever the route changes
  const routeKey = waypoints.map((w) => `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`).join('|')
  // Last route whose terrain arrived (look-ahead: carried forward while the next loads).
  const lastTerrainRef = useRef<{ wps: RouteWaypoint[]; pts: TerrainPoint[] } | null>(null)
  useEffect(() => {
    if (waypoints.length < 2) {
      setTerrainPts([])
      lastTerrainRef.current = null
      return
    }
    const controller = new AbortController()
    // Look-ahead refresh that only slid forward: keep the previous ground,
    // shifted, instead of blanking it until the new samples arrive (on a slow
    // link the next refresh used to come first, so no ground showed at all).
    const last = lastTerrainRef.current
    const carried = followAircraft && last ? carryLookaheadTerrain(last.wps, last.pts, waypoints) : null
    setTerrainPts(carried ?? [])
    setTerrainFailed(false)
    // API_BASE, not TILE_BASE -- /api/elevation/ is proxied by the api
    // server's nginx, a different host from TILE_BASE (which in production
    // points at the object-storage tile bucket domain). Using
    // TILE_BASE here hit the R2 bucket with a bogus path and came back with
    // a 401 misreported as "OpenTopoData HTTP 401" (found 2026-09-20).
    // The downloaded hillshade DEM stands in for the API offline; for the
    // look-ahead (asked again every few seconds) it goes first, so flying
    // costs the shared elevation budget nothing when it is downloaded.
    // A flight log is sampled densely from the downloaded DEM (~0.5 NM, free per sample).
    fetchTerrainProfileShared(waypoints, API_BASE, controller.signal, getOfflineDem(), { preferLookup: !!followAircraft || logMode, denseLookup: logMode })
      .then((pts) => {
        lastTerrainRef.current = { wps: waypoints, pts }
        setTerrainPts(pts)
        setTerrainFailed(false)
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') {
          console.warn('[VerticalProfile] terrain fetch failed:', err)
          lastTerrainRef.current = null
          setTerrainPts([])
          setTerrainFailed(true)
        }
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey])

  // Obstacles are collected out to the same abeam distance the MSA uses, so an
  // obstacle that raises the MSA is always on the chart.
  const abeamNm = resolveMsaMargins(msaMargins).abeamNm
  const rawProfile = useMemo(() => {
    if (waypoints.length < 2 || !airspaceGeo || !obstacleGeo) return null
    // water: undefined on native -- see the loader comment above.
    return buildVirtualRadarProfile(waypoints, legOverrides, airspaceGeo, obstacleGeo, undefined, landmarkGeo ?? undefined, airspaceCeilingFt ?? Infinity, aircraftProfile?.cruiseAltFt || undefined, { obstacleNm: abeamNm })
  }, [waypoints, legOverrides, airspaceGeo, obstacleGeo, landmarkGeo, airspaceCeilingFt, aircraftProfile?.cruiseAltFt, abeamNm])
  // AGL limits are published as heights: lift them onto the terrain along the
  // crossing once the terrain profile is in, so bands draw at their real altitude.
  const profile = useMemo(
    () => rawProfile && { ...rawProfile, airspaceBands: applyTerrainToBands(rawProfile.airspaceBands, terrainPts) },
    [rawProfile, terrainPts],
  )

  // Shared with web's VirtualRadar.tsx (getMsaLookup) — this used to be a
  // byte-for-byte duplicate independently maintained in both files.
  // Highest terrain within the abeam corridor, from the offline grid file.
  // No grid (not built yet / not fetched) = centreline samples only.
  const mefGrids = useMefGrids()
  const corridorFt = useMemo(
    () => corridorTerrainAlongRoute(waypoints, terrainPts, mefGrids, msaMargins),
    [waypoints, terrainPts, mefGrids, msaMargins],
  )
  const corridorPts = useMemo<TerrainPoint[]>(
    () => mefGrids.length === 0 ? [] : terrainPts.map((p, i) => ({ distNm: p.distNm, elevFt: Math.max(p.elevFt, corridorFt[i] ?? 0) })),
    [mefGrids, terrainPts, corridorFt],
  )
  // Terrain the MSA is built on: the fetched samples, or, once the fetch has failed
  // (offline, no hillshade DEM), samples made from the terrain grid so the MSA is not lost.
  const msaTerrain = useMemo(
    () => terrainForMsa(waypoints, terrainPts, mefGrids, msaMargins, terrainFailed),
    [waypoints, terrainPts, mefGrids, msaMargins, terrainFailed],
  )
  const msaObstacles = useMemo(
    () => profile ? obstacleTipsForMsa(profile.obstacles, profile.landmarks, (d) => terrainAt(msaTerrain.pts, d)) : undefined,
    [profile, msaTerrain],
  )
  const msaPts = useMemo<MsaPoint[]>(
    () => computeMsaProfile(msaTerrain.pts, msaMargins, msaObstacles, msaTerrain.corridorFt),
    [msaTerrain, msaMargins, msaObstacles],
  )
  // Per-leg MSA floor: the whole leg corridor incl. the circles around its ends.
  // (Not for a flight log: its path has no legs to set a level on.)
  const legMsaFloors = useMemo(
    () => (logMode ? [] : legCorridorMsaFt(waypoints, mefGrids, msaMargins, msaObstacles)),
    [waypoints, mefGrids, msaMargins, msaObstacles, logMode],
  )
  const getMsa = useMemo(() => getMsaLookup(msaPts), [msaPts])

  // Shared with web (@open-vfr/shared/profileChart).
  // The scale follows the path actually drawn (with the climbs and descents
  // the aircraft's performance allows), not the requested levels: a short leg
  // at 7500 ft is never reached, and a 10000 ft axis over a 3400 ft line is noise.
  const plannedAlts = useMemo(() => {
    if (!profile || terrainPts.length === 0) return [] as number[]
    return projectFlightPath(
      profile.altitudeProfile, profile.totalNm, perf ?? DEFAULT_PERF_MODEL,
      terrainPts.map(p => p.distNm), terrainPts[0].elevFt, terrainPts[terrainPts.length - 1].elevFt,
    )
  }, [perf, profile, terrainPts])
  // Flight log: the recorded altitudes take the plan's place for the scale.
  const flownAlts = useMemo(() => (flown ? flown.filter((p) => Number.isFinite(p.altFt)).map((p) => p.altFt) : null), [flown])
  const plannedPeakFt = useMemo(() => {
    if (!profile) return 0
    if (flownAlts) return flownAlts.reduce((m, a) => Math.max(m, a), 0)
    return plannedAlts.length > 0 ? Math.max(...plannedAlts) : profile.maxPlannedAltFt
  }, [profile, plannedAlts, flownAlts])
  const yMaxFull = useMemo(
    () => (profile ? profileYMax(plannedPeakFt, corridorPts.length > 0 ? corridorPts : terrainPts) : 10000),
    [profile, plannedPeakFt, corridorPts, terrainPts],
  )
  // Without a planned route (look-ahead while flying) the scale follows the aircraft's altitude and
  // vertical speed instead of a plan, so ground detail stays in view.
  const liveWindow = useMemo(
    () => (followAircraft && currentAltFt != null ? liveAltitudeWindow(currentAltFt, currentVSpeedFpm ?? 0) : null),
    [followAircraft, currentAltFt, currentVSpeedFpm],
  )
  const yMax = liveWindow ? liveWindow.yMax : yMaxFull
  // Bottom of the scale: 0 near the coast, raised over high ground so the route is not squashed.
  const yMin = useMemo(() => {
    if (liveWindow) return liveWindow.yMin
    if (!profile) return 0
    return profileYMin(terrainPts.map((p) => p.elevFt), flownAlts ?? plannedAlts, yMax)
  }, [profile, terrainPts, plannedAlts, flownAlts, yMax, liveWindow])

  const totalNm = profile?.totalNm ?? 0
  // Winds aloft at the standard levels up to the chart top, one column every ~20 NM.
  // Not for a flight log: today's forecast says nothing about a past flight.
  const windOn = showWindAloft && !logMode
  const { columns: windAloft, status: windAloftStatus } = useWindAloftAlongRoute(waypoints, totalNm, yMax, windOn)
  // Content (not panel) plot width: never below what the panel offers, but
  // grows past it once the route needs more than MIN_PX_PER_NM per NM to
  // stay legible (see MIN_PX_PER_NM comment above). contentW
  // is what actually gets drawn into the Svg; chartW is just the visible
  // clipping window. Geometry shared with web (@open-vfr/shared/profileChart).
  // Zoom on the distance axis (1 = fitted / minimum legible): + / − buttons and a
  // two-finger pinch. See zoomBy below.
  const [zoom, setZoom] = useState(1)
  const layout = useMemo(() => profileChartLayout({
    viewportW: chartW, height: chartH,
    margin: { top: MARGIN_T, right: MARGIN_R, bottom: MARGIN_B, left: MARGIN_L },
    totalNm, yMax, yMin, minPxPerNm: MIN_PX_PER_NM, zoom,
  }), [chartW, chartH, totalNm, yMax, yMin, zoom])
  const { plotW, plotH, contentW, scrollable, xOf, yOf } = layout
  const plotBottom = MARGIN_T + plotH

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

  // Obstacle and landmark symbols. Obstacles are collected out to the abeam
  // distance the MSA uses and fade with distance off track; the one that sets
  // the MSA is named in red; a crowd collapses to dots (highest first keeps its
  // pictogram). Landmarks thin out the same way, lower priority. Mirrors web.
  const { obstacleMarks, landmarkMarks, poiMarks } = useMemo(() => {
    const margins = resolveMsaMargins(msaMargins)
    // Symbols at the very start/end of the route (the destination's church, an
    // aerodrome on the last waypoint) are kept fully inside the plot instead of
    // being half cut off at its edge.
    const clampX = (x: number, half: number) => Math.max(xOf(0) + half, Math.min(xOf(totalNm) - half, x))
    const obs = (profile?.obstacles ?? []).map((o, i) => {
      const baseFt = Math.max(o.elevationFt, terrainAt(terrainPts, o.distNm))
      // Unknown height: the per-kind estimate (dashed, and the same figure the
      // MSA uses, see obstacleHeights.ts).
      const eh = effectiveHeight(o.kind, o.heightM)
      const tipFt = Math.round(baseFt + eh.heightM * FT_PER_M)
      const limiting = isLimitingObstacle(tipFt, margins.obstacleClearanceFt, getMsa(o.distNm))
      const cx = clampX(xOf(o.distNm), 8), cy = yOf(tipFt), groundY = yOf(Math.max(0, baseFt))
      // The symbol spans the true tip altitude down to the real ground (symbolGroundY).
      const symY = symbolGroundY(cy, groundY, plotBottom)
      return {
        key: `obs-${i}`, kind: o.kind, cx, cy, groundY,
        opacity: obstacleOpacity(o.lateralNm, margins.abeamNm) * (eh.estimated ? 0.85 : 1), limiting,
        priority: limiting ? 1e9 + tipFt : tipFt, full: false, estimated: eh.estimated,
        label: limiting && showObstLabels ? limitingObstacleLabel(o.kind, o.name, tipFt, eh.estimated) : '', labelPos: undefined as PlacedLabel | undefined, leader: false,
        symY, shape: obstacleSymbol(o.kind, cx, cy, symY, eh.estimated),
      }
    })
    // Limiting obstacles close together (a wind farm) share one label ("+1").
    mergeNearbyLabels(obs, LIMITING_LABEL_MERGE_PX)
    const obsFull = declutterMarks(obs.map((m) => ({ id: m.key, x: m.cx, priority: m.priority })), 14)
    obs.forEach((m) => { m.full = obsFull.has(m.key) })
    const lmk = (profile?.landmarks ?? []).map((l, i) => {
      // Floor at 0: landmarks rely purely on terrainAt(), which can go
      // negative from DEM noise over/near water.
      const baseFt = Math.max(0, terrainAt(terrainPts, l.distNm))
      const eh = effectiveHeight(l.kind, l.heightM)
      const cx = clampX(xOf(l.distNm), 7), groundY = yOf(baseFt)
      const tipY = yOf(Math.round(baseFt + eh.heightM * FT_PER_M))
      return {
        key: `lmk-${i}`, kind: l.kind, cx, cy: groundY, tipY, full: false, estimated: eh.estimated,
        shape: obstacleSymbol(LANDMARK_SHAPE_KIND[l.kind] ?? 'tower', cx, tipY, groundY, eh.estimated),
      }
    })
    const lmkFull = declutterMarks(lmk.map((m) => ({ id: m.key, x: m.cx, priority: 0 })), 18)
    lmk.forEach((m) => { m.full = lmkFull.has(m.key) })
    // Aerodromes / reporting points / navaids: symbols always drawn, labels
    // thinned by priority (aerodromes first, towered before others).
    const pois = collectRoutePois(waypoints, poiSets).map((p, i) => {
      const baseFt = poiBaseFt(p, terrainAt(terrainPts, p.distNm))
      return {
        key: `poi-${i}`, kind: p.kind, subtype: p.subtype, towered: p.towered, label: p.label,
        cx: clampX(xOf(p.distNm), 6),
        // Stands on the ground line (like the obstacles) instead of being centred on it.
        cy: poiCenterY(yOf(baseFt), plotBottom),
        priority: p.kind === 'aerodrome' ? (p.towered ? 4 : 3) : p.kind === 'navaid' ? 2 : 1, labelPos: undefined as PlacedLabel | undefined,
      }
    })
    // Names (the obstacle that sets the MSA, aerodromes, navaids, reporting
    // points) are placed by rectangle: each tries above / below / beside its
    // symbol and takes the first spot clear of every symbol and other label.
    // Same logic as web (@open-vfr/shared/profileLabels).
    const sym = (cx: number, top: number, bottom: number, half: number): BoxRect => ({ left: cx - half, right: cx + half, top, bottom })
    const obsBox = (m: (typeof obs)[number]) => !m.full ? sym(m.cx, m.cy - 3, m.cy + 3, 3)
      : m.shape ? sym(m.cx, m.cy, m.symY, 11) : sym(m.cx, m.cy - 16, Math.max(m.cy, m.groundY), 8)
    const avoid: BoxRect[] = [
      ...obs.map(obsBox),
      ...lmk.map((m) => !m.full ? sym(m.cx, m.cy - 2, m.cy + 2, 2)
        : m.shape ? sym(m.cx, m.tipY, m.cy, 11) : sym(m.cx, m.cy - 14, m.cy, 7)),
      ...pois.map((m) => sym(m.cx, m.cy - 6, m.cy + 6, 6)),
    ]
    const requests: LabelRequest[] = [
      ...obs.filter((m) => m.limiting && m.label).map((m) => {
        const b = obsBox(m)
        return { id: m.key, x: m.cx, top: b.top, bottom: b.bottom, halfW: 8, w: obstacleLabelWidth(m.label), h: OBSTACLE_LABEL_H, priority: m.priority }
      }),
      ...pois.filter((m) => m.label).map((m) => ({
        id: m.key, x: m.cx, top: m.cy - 6, bottom: m.cy + 6, halfW: 6, w: poiLabelWidth(m.label), h: POI_LABEL_H, priority: m.priority,
      })),
    ]
    // Names also keep clear of the airspace chips and the cloud glyphs.
    const chipBoxes: BoxRect[] = layoutAirspaceChips(airspaceChips(profile?.airspaceBands ?? [], yMax), xOf, yOf)
      .map((c): BoxRect => ({ left: c.px, right: c.px + c.w, top: c.py, bottom: c.py + c.h }))
    const hw = cloudStripHalfWidthNm(totalNm)
    const cloudBoxes: BoxRect[] = weatherMarks.flatMap((m) => m.clouds.map((c): BoxRect => {
      const yb = yOf(c.baseFt)
      return { left: xOf(Math.max(0, m.distNm - hw)), right: xOf(Math.min(totalNm, m.distNm + hw)), top: yb - cloudGlyphHeight(c), bottom: yb }
    }))
    // A limiting obstacle's name is never dropped: lifted with a leader line, or placed with fewer constraints.
    const { placed, leaders } = placeRadarLabels({
      requests, symbols: avoid, chips: chipBoxes, clouds: cloudBoxes, mustShow: (id) => id.startsWith('obs-'),
      area: { left: MARGIN_L, right: MARGIN_L + plotW, top: MARGIN_T + 14, bottom: plotBottom - 2 },
    })
    obs.forEach((m) => { m.leader = leaders.has(m.key); m.labelPos = placed.get(m.key) })
    pois.forEach((m) => { m.labelPos = placed.get(m.key) })
    return { obstacleMarks: obs, landmarkMarks: lmk, poiMarks: pois }
  }, [profile, terrainPts, getMsa, msaMargins, xOf, yOf, totalNm, waypoints, poiSets, yMax, plotW, plotBottom, weatherMarks, showObstLabels])
  const maxScrollX  = Math.max(0, contentW - chartW)
  // Clamped x for wind arrows/labels only -- keeps the marker inside the
  // plot area by WIND_EDGE_MARGIN_PX regardless of route length, falling
  // back to plotW/2 on a route too short for the full margin on both sides.
  const windXOf = useCallback((distNm: number) => {
    const margin = Math.min(WIND_EDGE_MARGIN_PX, plotW / 2)
    return Math.min(MARGIN_L + plotW - margin, Math.max(MARGIN_L + margin, xOf(distNm)))
  }, [xOf, plotW])

  // Waypoint-name label collision avoidance, on the real label rectangles
  // (see @open-vfr/shared/profileLabels): names are variable-width and the
  // destination label is clamped toward the left to stay inside the chart,
  // so spacing the ticks alone let it land on the previous label. The
  // destination always wins; the departure is skipped (it sits on the Y axis).
  const wpLabelRect = useCallback((name: string, distNm: number) => {
    // Clamp by the label's own width, and to the PLOT's right edge (not the
    // wider content incl. the right margin): a long destination name such as
    // "Sankt Pauli kyrka" (and its ellipsis) must stay inside the chart box.
    const w = wpLabelWidth(name)
    const left = Math.max(0, Math.min(xOf(totalNm) - w - 2, xOf(distNm) + 2))
    return { left, right: left + w }
  }, [xOf, totalNm])
  const visibleWaypointTicks = useMemo(() => {
    if (!profile) return []
    const ticks = profile.waypointTicks
    const keep = pickWaypointLabels(ticks.map((t) => wpLabelRect(t.name, t.distNm)), xOf(0))
    return keep.map((i) => ticks[i])
  }, [profile, xOf, wpLabelRect])

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
  //     a crosshair marker on the map (native equivalent of web's pointer
  //     hover readout).
  //  2. Pan — when the route is wider than the panel (MIN_PX_PER_NM,
  //     above), a drag scrolls the content, with a fling (decay) on release.
  //     A scrollable chart scrubs only after the finger was held still for
  //     ROUTE_HOLD_MS (noticed on its first move after that); a flight log
  //     scrubs by dragging its aircraft. One gesture drives all of it, so
  //     the forms of horizontal drag never race two gesture systems.
  // Runs on the UI thread: scroll offset and crosshair are shared values
  // read by animated styles, so dragging never re-renders the chart. The
  // map crosshair is reported to JS at most every HOVER_REPORT_MS.

  // ── Zoom ────────────────────────────────────────────────────────────────
  // A pinch previews as a cheap scaleX of the already-drawn content (UI
  // thread, no re-render) and commits one real re-layout when the fingers
  // lift; the buttons commit straight away. The route position under the
  // pinch centre / viewport middle stays put (scrollAfterZoom).
  const zoomRef = useRef(zoom); zoomRef.current = zoom
  const layoutRef = useRef(layout); layoutRef.current = layout
  const chartWRef = useRef(chartW); chartWRef.current = chartW
  const pendingScrollRef = useRef<number | null>(null)
  const pinchScale = useSharedValue(1)
  const pinchFocal = useSharedValue(0)
  const zoomSV = useSharedValue(1)
  const maxRatioSV = useSharedValue(1)
  const zoomBy = useCallback((factor: number, anchorPx?: number) => {
    const L0 = layoutRef.current, vw = chartWRef.current
    const base = L0.plotW / zoomRef.current
    const next = clampProfileZoom(zoomRef.current * factor, base, L0.totalNm)
    if (next === zoomRef.current) { pinchScale.value = 1; return }
    const newPlotW = base * next
    pendingScrollRef.current = scrollAfterZoom({
      scrollLeft: scrollXRef.current, anchorPx: anchorPx ?? vw / 2, plotLeft: L0.plotLeft,
      oldPlotW: L0.plotW, newPlotW, viewportW: vw, newContentW: newPlotW + MARGIN_L + MARGIN_R,
    })
    zoomRef.current = next
    setZoom(next)
  }, [pinchScale])
  const commitPinch = useCallback((scale: number, focal: number) => {
    scrollXRef.current = scrollX.value
    zoomBy(scale, focal)
  }, [zoomBy, scrollX])
  useEffect(() => {
    zoomSV.value = zoom
    maxRatioSV.value = clampProfileZoom(1e9, plotW / zoom, totalNm) / zoom
    if (pendingScrollRef.current != null) { setScroll(pendingScrollRef.current); pendingScrollRef.current = null }
    pinchScale.value = 1
  }, [zoom, plotW, totalNm, zoomSV, maxRatioSV, pinchScale, setScroll])

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
    // Flight log: a release (null) must not replace a pending tap or drag position.
    if (nm == null && flownRef.current) return
    const idle = pendingHoverRef.current == null
    pendingHoverRef.current = { nm }
    if (idle) requestAnimationFrame(() => {
      const v = pendingHoverRef.current
      pendingHoverRef.current = null
      if (!v) return
      const fl = flownRef.current
      if (fl) {
        // Flight log: the aircraft stays where it was left.
        if (v.nm == null || fl.length === 0) return
        const idx = flownIndexAt(fl, v.nm)
        flownStore.set({ idx, touched: true })
        onHoverDistNmRef.current?.(fl[idx].distNm)
        return
      }
      onHoverDistNmRef.current?.(v.nm)
    })
  }, [flownStore])
  const dragStarted   = useCallback(() => { draggingRef.current = true }, [])
  const dragEnded     = useCallback(() => { draggingRef.current = false }, [])
  const scrollSettled = useCallback((x: number, panned: boolean) => {
    scrollXRef.current = x
    if (panned) manualPanUntilRef.current = Date.now() + MANUAL_PAN_GRACE_MS
  }, [])

  // ── Leg level drag state (see the gesture below) ───────────────────────
  const legSegsSV = useSharedValue<number[]>([])
  const legEnabledSV = useSharedValue(false)
  const legHitSV = useSharedValue(-1)
  // Leg whose level may be dragged: -1 = every leg, -2 = none, else that leg.
  const legEditOnlySV = useSharedValue(-1)
  const legTapSV = useSharedValue(false)
  const legModeSV = useSharedValue(0)   // 0 undecided, 1 level drag, 2 normal pan
  // The drag lives in a small external store, not React state: a drag step then re-renders only the overlay
  // that subscribes to it, not this whole chart (obstacles, winds, labels), which cost ~50-80 ms per step.
  const dragStore = useRef(createDragStore()).current
  const dragging = useSyncExternalStore(dragStore.subscribe, () => dragStore.get() !== null)
  const legTouchYSV = useSharedValue(0)
  const legSpanList = useMemo(() => (profile ? legSpans(profile.altitudeProfile) : []), [profile])
  const legMsaFt = useMemo(() => legMsaList(legSpanList, msaPts, getMsa, legMsaFloors), [legSpanList, msaPts, getMsa, legMsaFloors])
  // Requested levels the drawn path never reaches (a short leg cannot climb that
  // far): shown as a dashed marker instead of silently ignored.
  const unreached = useMemo(() => {
    if (!profile || profile.altitudeProfile.length === 0) return []
    const line = plannedAltitudeLine(profile.altitudeProfile, profile.totalNm, perf, terrainPts[0]?.elevFt ?? 0, terrainPts[terrainPts.length - 1]?.elevFt ?? 0)
    return unreachedLegs(legSpanList, line)
  }, [profile, perf, terrainPts, legSpanList])
  const legPxPerFt = (yOf(0) - yOf(10000)) / 10000
  const legCeilingFt = Math.min(aircraftProfile?.serviceCeilingFt || 50_000, Math.round(yMax / 100) * 100)
  const legFallbackAltFt = aircraftProfile?.cruiseAltFt || 3500
  const legGroundY = yOf(0)
  const legInputsRef = useRef({ legSpanList, legPxPerFt, legCeilingFt, legOverrides, onLegLevelChange, legGroundY })
  legInputsRef.current = { legSpanList, legPxPerFt, legCeilingFt, legOverrides, onLegLevelChange, legGroundY }
  const legDragBegin = useCallback((leg: number, touchY: number) => {
    const { legSpanList: spans, legPxPerFt: pxPerFt, legGroundY: y0 } = legInputsRef.current
    const span = spans[leg]
    if (!span) return
    // Start from the altitude DRAWN under the finger, not the leg's requested
    // level: a level the aircraft cannot reach on this distance sits far above
    // the drawn line, and starting there made the line jump to the top.
    const startAlt = Math.min(span.altFt, altAtY(touchY, y0, pxPerFt))
    dragStore.set({ leg, startAlt, cand: startAlt >= LEVEL_STEP_FT ? startAlt : null, shown: startAlt, moved: false })
  }, [])
  const legDragMove = useCallback((dy: number) => {
    const cur = dragStore.get()
    if (!cur) return
    const { legPxPerFt: pxPerFt, legCeilingFt: ceil } = legInputsRef.current
    // Never clamp below where the drag started.
    const shown = Math.min(dragShownFt(cur.startAlt, dy, pxPerFt), Math.max(ceil, cur.startAlt))
    const cand = shown < LEVEL_STEP_FT ? null : shown
    const moved = cur.moved || Math.abs(dy) >= DRAG_MIN_MOVE_PX
    if (shown !== cur.shown || cand !== cur.cand || moved !== cur.moved) dragStore.set({ ...cur, shown, cand, moved })
  }, [])
  const onLegTapRef = useRef(onLegTap)
  onLegTapRef.current = onLegTap
  const reportLegTap = useCallback((leg: number) => { onLegTapRef.current?.(leg) }, [])
  const legDragEnd = useCallback((success: boolean) => {
    const cur = dragStore.get()
    dragStore.set(null)
    const cb = legInputsRef.current.onLegLevelChange
    // A press without real movement is not an edit.
    if (!cur || !success || !cb || !cur.moved) return
    const level = legInputsRef.current.legSpanList[cur.leg]?.altFt
    if (cur.cand === null) { if (legInputsRef.current.legOverrides[cur.leg]?.altFt != null) cb(cur.leg, null) }
    else if (cur.cand !== level) cb(cur.leg, cur.cand)
  }, [])

  const scrub = usePanGesture({
    minDistance: 0,
    onBegin: (e) => {
      'worklet'
      cancelAnimation(scrollX)
      dragStartX.value = scrollX.value
      const tNm = totalNmSV.value, pW = plotWSV.value
      // Flight log: a touch on the aircraft (or anywhere when the chart does not scroll) moves it;
      // elsewhere the drag only pans and a tap moves the aircraft there (see onFinalize).
      flownMoveSV.value = 0
      flownBeginSV.value = { t: Date.now(), x: e.x }
      if (flownModeSV.value) {
        const dx = e.x + scrollX.value - acXSV.value, dy = e.y - acYSV.value
        flownScrubSV.value = (dx * dx + dy * dy <= FLOWN_HANDLE_R * FLOWN_HANDLE_R || maxScrollXSV.value <= 0) ? 1 : 0
      }
      // Route on a scrollable chart: a drag pans; holding still for a moment first scrubs instead
      // (a drag both panning and scrubbing moved the chart under the finger, so the inspected
      // point never changed). A chart that fits the panel scrubs straight away.
      routeScrubSV.value = maxScrollXSV.value > 0 ? 0 : 1
      const reportNow = flownModeSV.value ? flownScrubSV.value === 1 : routeScrubSV.value === 1
      hoverX.value = reportNow ? e.x : -1
      if (reportNow && tNm > 0 && pW > 0) {
        scheduleOnRN(reportHover, Math.max(0, Math.min(tNm, ((e.x + scrollX.value - MARGIN_L) / pW) * tNm)))
      }
      lastHoverReport.value = Date.now()
      scheduleOnRN(dragStarted)
      // Leg level drag: did the touch land on a leg's drawn line? Decided
      // (vertical = level drag, horizontal = normal scrub/pan) on first moves.
      legHitSV.value = -1
      legModeSV.value = 0
      legTouchYSV.value = e.y
      if (legEnabledSV.value) {
        const segs = legSegsSV.value
        const px = e.x + scrollX.value, py = e.y
        let best = -1, bestD = LEG_HIT_PX * LEG_HIT_PX
        for (let k = 0; k + 4 < segs.length; k += 5) {
          const ax = segs[k + 1], ay = segs[k + 2], bx = segs[k + 3], by = segs[k + 4]
          const dx = bx - ax, dy = by - ay
          const len2 = dx * dx + dy * dy
          let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
          t = t < 0 ? 0 : t > 1 ? 1 : t
          const cx = ax + t * dx - px, cy = ay + t * dy - py
          const d2 = cx * cx + cy * cy
          if (d2 < bestD) { bestD = d2; best = segs[k] }
        }
        legHitSV.value = best
      }
    },
    onUpdate: (e) => {
      'worklet'
      const legDraggable = legHitSV.value >= 0 && (legEditOnlySV.value === -1 || legEditOnlySV.value === legHitSV.value)
      if (legDraggable) {
        if (legModeSV.value === 0) {
          const ay = Math.abs(e.translationY), ax = Math.abs(e.translationX)
          if (ay > 8 && ay > ax) {
            legModeSV.value = 1
            // The scrub crosshair (and the map cursor it drives) is for horizontal scrubbing only.
            hoverX.value = -1
            scheduleOnRN(reportHover, null)
            scheduleOnRN(legDragBegin, legHitSV.value, legTouchYSV.value)
          }
          else if (ax > 8) legModeSV.value = 2
        }
        if (legModeSV.value === 1) { scheduleOnRN(legDragMove, e.translationY); return }
      }
      flownMoveSV.value = Math.max(flownMoveSV.value, Math.abs(e.translationX), Math.abs(e.translationY))
      if (!flownModeSV.value && routeScrubSV.value !== 1) {
        if (routeScrubSV.value === 0) {
          if (flownMoveSV.value > FLOWN_TAP_SLOP_PX) routeScrubSV.value = 2
          else if (Date.now() - flownBeginSV.value.t >= ROUTE_HOLD_MS) routeScrubSV.value = 1
        }
        if (routeScrubSV.value === 2) {
          scrollX.value = Math.max(0, Math.min(maxScrollXSV.value, dragStartX.value - e.translationX))
          return
        }
        if (routeScrubSV.value === 0) return
      }
      if (!flownModeSV.value && routeScrubSV.value === 1) {
        // Scrubbing a route: the chart stays put, except at its edges, where it scrolls along.
        const vw = chartWSV.value
        if (e.x < FLOWN_EDGE_PX) scrollX.value = Math.max(0, scrollX.value - FLOWN_EDGE_STEP_PX)
        else if (vw > 0 && e.x > vw - FLOWN_EDGE_PX) scrollX.value = Math.min(maxScrollXSV.value, scrollX.value + FLOWN_EDGE_STEP_PX)
        hoverX.value = e.x
        const now = Date.now()
        if (now - lastHoverReport.value >= HOVER_REPORT_MS) {
          lastHoverReport.value = now
          const tNm = totalNmSV.value, pW = plotWSV.value
          if (tNm > 0 && pW > 0) scheduleOnRN(reportHover, Math.max(0, Math.min(tNm, ((e.x + scrollX.value - MARGIN_L) / pW) * tNm)))
        }
        return
      }
      if (flownModeSV.value) {
        if (flownScrubSV.value === 0) {
          // Not on the aircraft: pan only.
          scrollX.value = Math.max(0, Math.min(maxScrollXSV.value, dragStartX.value - e.translationX))
          return
        }
        // Moving the aircraft: the chart stays put, except held at an edge, where it scrolls along.
        const vw = chartWSV.value
        if (e.x < FLOWN_EDGE_PX) scrollX.value = Math.max(0, scrollX.value - FLOWN_EDGE_STEP_PX)
        else if (vw > 0 && e.x > vw - FLOWN_EDGE_PX) scrollX.value = Math.min(maxScrollXSV.value, scrollX.value + FLOWN_EDGE_STEP_PX)
        hoverX.value = e.x
        const now = Date.now()
        if (now - lastHoverReport.value >= HOVER_REPORT_MS) {
          lastHoverReport.value = now
          const tNm = totalNmSV.value, pW = plotWSV.value
          if (tNm > 0 && pW > 0) scheduleOnRN(reportHover, Math.max(0, Math.min(tNm, ((e.x + scrollX.value - MARGIN_L) / pW) * tNm)))
        }
        return
      }
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
      const scrubbing = flownModeSV.value ? flownScrubSV.value === 1 : routeScrubSV.value === 1
      if (maxScrollXSV.value > 0 && Math.abs(e.velocityX) > 50 && !scrubbing) {
        const panned = scrollX.value !== dragStartX.value
        scrollX.value = withDecay(
          { velocity: -e.velocityX, clamp: [0, maxScrollXSV.value], deceleration: 0.997 },
          (finished) => { if (finished) scheduleOnRN(scrollSettled, scrollX.value, panned) },
        )
      }
    },
    onFinalize: (e) => {
      'worklet'
      if (legModeSV.value === 1) scheduleOnRN(legDragEnd, !e.canceled)
      // A tap on a leg's line (no drag): report it (in flight: unlock the leg).
      else if (legTapSV.value && legHitSV.value >= 0 && !flownModeSV.value
        && flownMoveSV.value < FLOWN_TAP_SLOP_PX && Date.now() - flownBeginSV.value.t <= FLOWN_TAP_MAX_MS) {
        scheduleOnRN(reportLegTap, legHitSV.value)
      }
      // Flight log: a tap away from the aircraft moves it there.
      // (Not gated on e.canceled: a quick tap that never moved ends the pan gesture as
      // cancelled / failed, which is exactly the tap we want.)
      if (flownModeSV.value && flownScrubSV.value === 0
        && flownMoveSV.value < FLOWN_TAP_SLOP_PX && Date.now() - flownBeginSV.value.t <= FLOWN_TAP_MAX_MS) {
        const tNm = totalNmSV.value, pW = plotWSV.value
        if (tNm > 0 && pW > 0) scheduleOnRN(reportHover, Math.max(0, Math.min(tNm, ((flownBeginSV.value.x + scrollX.value - MARGIN_L) / pW) * tNm)))
      }
      flownScrubSV.value = 0
      legHitSV.value = -1
      legModeSV.value = 0
      hoverX.value = -1
      scheduleOnRN(reportHover, null)
      scheduleOnRN(scrollSettled, scrollX.value, scrollX.value !== dragStartX.value)
      scheduleOnRN(dragEnded)
    },
  })
  const pinch = usePinchGesture({
    onUpdate: (e) => {
      'worklet'
      // keep the live scale inside [1 / zoom, max] so the preview never overshoots the limits
      pinchScale.value = Math.max(1 / zoomSV.value, Math.min(maxRatioSV.value, e.scale))
      pinchFocal.value = e.focalX
    },
    onFinalize: () => {
      'worklet'
      if (pinchScale.value !== 1) scheduleOnRN(commitPinch, pinchScale.value, pinchFocal.value)
    },
  })
  const chartGesture = useSimultaneousGestures(scrub, pinch)
  const contentStyle = useAnimatedStyle(() => {
    const sc = pinchScale.value
    if (sc === 1) return { transform: [{ translateX: -scrollX.value }] }
    // scaleX is about the content's centre (RN default), so fold that into the
    // translation: the content point under the pinch focal point stays put.
    const cx = (plotWSV.value + MARGIN_L + MARGIN_R) / 2
    return { transform: [{ translateX: pinchFocal.value - sc * (pinchFocal.value + scrollX.value) + cx * (sc - 1) }, { scaleX: sc }] }
  })
  const crosshairStyle = useAnimatedStyle(() => ({
    opacity: hoverX.value < 0 ? 0 : 1,
    transform: [{ translateX: Math.max(0, hoverX.value) }],
  }))

  // Departure/arrival elevation from first/last terrain sample (aerodrome elevation proxy)
  const depElevFt = terrainPts[0]?.elevFt ?? 0
  const arrElevFt = terrainPts[terrainPts.length - 1]?.elevFt ?? 0

  // Planned altitude at each terrain sample -- same model as plannedPath
  // (generic performance when no aircraft is selected), used to flag the
  // stretches below MSA.
  // Sample points of the projected path: the terrain samples, or the grid-made
  // samples when only the terrain grid is available (no ground line then).
  const pathSamples = terrainPts.length > 0 ? terrainPts : (msaTerrain.fromGridOnly ? msaTerrain.pts : NO_SAMPLES)
  const projAlts = useMemo(() => {
    if (!profile || pathSamples.length === 0) return null
    return projectFlightPath(
      profile.altitudeProfile, profile.totalNm, perf ?? DEFAULT_PERF_MODEL,
      pathSamples.map(p => p.distNm), depElevFt, arrElevFt,
    )
  }, [perf, profile, pathSamples, depElevFt, arrElevFt])

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

  // Faint corridor-maximum silhouette behind the solid centreline terrain.
  const corridorFill = useMemo(() => {
    if (!corridorBand || corridorPts.length === 0 || plotW <= 0) return ''
    const pts = corridorPts.map(p => `${xOf(p.distNm).toFixed(1)},${yOf(p.elevFt).toFixed(1)}`)
    const bottomY = MARGIN_T + plotH
    return `M${xOf(0).toFixed(1)},${bottomY} L${pts.join(' L')} L${xOf(totalNm).toFixed(1)},${bottomY} Z`
  }, [corridorBand, corridorPts, plotW, plotH, xOf, yOf, totalNm])

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
  const plannedLine = useMemo(
    () => (!profile || profile.altitudeProfile.length === 0 ? [] : plannedAltitudeLine(profile.altitudeProfile, profile.totalNm, perf, depElevFt, arrElevFt)),
    [profile, perf, depElevFt, arrElevFt],
  )
  const plannedPath = useMemo(() => {
    if (plannedLine.length === 0) return ''
    return `M${plannedLine.map(p => `${xOf(p.distNm).toFixed(1)},${yOf(p.altFt).toFixed(1)}`).join(' L')}`
  }, [plannedLine, xOf, yOf])
  // Top of climb / top of descent on the flown path, and the planned altitude where a leg ends (turn dots).
  const phaseMarks = useMemo(() => verticalPhaseMarks(plannedLine), [plannedLine])
  const plannedAltAt = useCallback((distNm: number): number | null => {
    for (let k = 0; k + 1 < plannedLine.length; k++) {
      const a = plannedLine[k], b = plannedLine[k + 1]
      if (distNm >= a.distNm && distNm <= b.distNm) return b.distNm === a.distNm ? b.altFt : a.altFt + ((distNm - a.distNm) / (b.distNm - a.distNm)) * (b.altFt - a.altFt)
    }
    return null
  }, [plannedLine])
  // TOC / TOD labels: placed clear of chips, obstacle / aerodrome names and each other (right of the dot
  // first, then above, below, left). A climb that ends below the level set for its leg is flagged amber.
  const phaseLayout = useMemo(() => {
    if (!profile) return []
    const taken: BoxRect[] = [
      ...layoutAirspaceChips(airspaceChips(profile.airspaceBands, yMax), xOf, yOf).map((c): BoxRect => ({ left: c.px, right: c.px + c.w, top: c.py, bottom: c.py + c.h })),
      ...obstacleMarks.filter((m) => m.labelPos).map((m): BoxRect => ({ left: m.labelPos!.left, right: m.labelPos!.left + obstacleLabelWidth(m.label), top: m.labelPos!.baseline - 13, bottom: m.labelPos!.baseline + 3 })),
      ...poiMarks.filter((m) => m.labelPos).map((m): BoxRect => ({ left: m.labelPos!.left, right: m.labelPos!.left + poiLabelWidth(m.label), top: m.labelPos!.baseline - 12, bottom: m.labelPos!.baseline + 3 })),
    ]
    const shown = phaseMarks.filter((m) => m.altFt <= yMax && m.altFt >= yMin).map((m) => {
      const short = m.kind === 'TOC' ? unreached.find((u) => { const sp = legSpanList[u.legIndex]; return sp && m.distNm >= sp.fromNm - 0.01 && m.distNm <= sp.toNm + 0.01 }) : undefined
      const text = phaseLabelText(m.kind, m.altFt, short?.levelFt)
      return { m, short: !!short, text, x: xOf(m.distNm), y: yOf(m.altFt), w: Math.ceil(text.length * 6.6) + 4, pl: undefined as PlacedLabel | undefined }
    })
    shown.forEach((p) => taken.push({ left: p.x - 4, right: p.x + 4, top: p.y - 4, bottom: p.y + 4 }))
    shown.forEach((p, k) => {
      const got = placeLabels([{ id: String(k), x: p.x, top: p.y - 4, bottom: p.y + 4, halfW: 6, w: p.w, h: 14, priority: 1 }], taken,
        { left: MARGIN_L, right: MARGIN_L + plotW, top: MARGIN_T + 14, bottom: plotBottom - 2 }).get(String(k))
      if (got) { p.pl = got; taken.push({ left: got.left, right: got.left + p.w, top: got.baseline - 12, bottom: got.baseline + 2 }) }
    })
    return shown
  }, [profile, phaseMarks, obstacleMarks, poiMarks, unreached, legSpanList, xOf, yOf, yMax, yMin, plotW, plotBottom])

  // Below-MSA stretches of the planned line (drawn red over the magenta line)
  const projDangerPath = useMemo(() => {
    if (!projAlts || pathSamples.length === 0) return ''
    // Shared with web (@open-vfr/shared/profileChart): same endpoint
    // suppression and transition points on both apps.
    return belowMsaRuns({ distNms: pathSamples.map((p) => p.distNm), plannedAlts: projAlts, getMsa, totalNm })
      .map((run) => polylinePath(run, xOf, yOf))
      .join(' ')
  }, [projAlts, pathSamples, getMsa, totalNm, xOf, yOf])

  // Flight log: flown line in continuous runs, recording gaps, and its below-MSA stretches.
  const flownDraw = useMemo(() => {
    if (!flown) return null
    const { runs, gaps } = flownLineParts(flown)
    const pts = flown.filter((p) => Number.isFinite(p.altFt))
    const msaKnown = terrainPts.length > 0 || msaTerrain.fromGridOnly
    // No endpoint allowance (a log starts and ends on the ground); low near an aerodrome on the
    // track, or the log's own start and end, is amber instead of red.
    const belowRuns = msaKnown
      ? belowMsaRuns({ distNms: pts.map((p) => p.distNm), plannedAlts: pts.map((p) => p.altFt), getMsa, totalNm, suppressNm: 0 })
      : []
    const fieldNms = [0, flown[flown.length - 1]?.distNm ?? 0,
      ...collectRoutePois(waypoints, poiSets).filter((p) => p.kind === 'aerodrome' && p.lateralNm <= 1.5).map((p) => p.distNm)]
    const split = splitBelowMsaNearFields(belowRuns, fieldNms, FLOWN_NEAR_FIELD_NM)
    const speedScale = flownSpeedScale(flown)
    const ys = (k: number) => MARGIN_T + plotH - (k / speedScale.topKts) * plotH
    return {
      runs: runs.map((r) => polylinePath(r, xOf, yOf)).join(' '),
      gaps: gaps.map(([a, b]) => ({ x1: xOf(a.distNm), y1: yOf(a.altFt), x2: xOf(b.distNm), y2: yOf(b.altFt) })),
      below: split.away.map((r) => polylinePath(r, xOf, yOf)).join(' '),
      belowNear: split.nearField.map((r) => polylinePath(r, xOf, yOf)).join(' '),
      speed: flownSpeedRuns(flown).map((r) => 'M' + r.map((p) => `${xOf(p.distNm).toFixed(1)},${ys(p.spdKts).toFixed(1)}`).join(' L')).join(' '),
      speedTopKts: speedScale.topKts,
      gapInfo: flownGaps(flown),
      entries: profile ? flownAirspaceEntries(flown, profile.airspaceBands).length : 0,
    }
  }, [flown, terrainPts, msaTerrain, getMsa, totalNm, xOf, yOf, plotH, waypoints, poiSets, profile])

  // Planned level along the flown track (route stored with the log), at the terrain samples;
  // null where the track left the route.
  const flownPlanned = useMemo(() => {
    if (!flown || !plannedRoute || pathSamples.length === 0) return null
    const samples = pathSamples.map((p) => flownCoordinateAt(flown, p.distNm) ?? { lat: 0, lng: 0 })
    const alts = plannedAltitudesAlongTrack(plannedRoute, samples, perf, aircraftProfile?.cruiseAltFt || undefined)
    const runs: { distNm: number; altFt: number }[][] = []
    let cur: { distNm: number; altFt: number }[] = []
    alts.forEach((a, i) => {
      if (a == null) { if (cur.length > 1) runs.push(cur); cur = []; return }
      cur.push({ distNm: pathSamples[i].distNm, altFt: a })
    })
    if (cur.length > 1) runs.push(cur)
    return { path: runs.map((r) => polylinePath(r, xOf, yOf)).join(' '), alts, distNms: pathSamples.map((p) => p.distNm) }
  }, [flown, plannedRoute, pathSamples, perf, aircraftProfile?.cruiseAltFt, xOf, yOf])

  // Opened from an event in the Logs list: inspect the recorded point at that time (aircraft,
  // readout and map marker there, chart scrolled to it).
  useEffect(() => {
    if (!flown || !jumpToTs || flown.length === 0 || chartW <= 0) return
    let best = 0
    for (let i = 1; i < flown.length; i++) if (Math.abs(flown[i].ts - jumpToTs.ts) < Math.abs(flown[best].ts - jumpToTs.ts)) best = i
    flownStore.set({ idx: best, touched: true })
    onHoverDistNmRef.current?.(flown[best].distNm)
    setScroll(Math.max(0, Math.min(maxScrollX, xOf(flown[best].distNm) - chartW / 2)))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToTs, flown, flownStore, chartW > 0, profile != null])

  // Hit segments for the leg level drag: the drawn planned line (climbs and
  // descents included), each piece assigned to the leg it lies in. Flat
  // [leg, x0, y0, x1, y1, ...] in content px, read by the gesture worklet.
  useEffect(() => {
    legEnabledSV.value = !!onLegLevelChange || !!onLegTap
    legEditOnlySV.value = !onLegLevelChange ? -2 : levelEditLeg === undefined ? -1 : levelEditLeg === null ? -2 : levelEditLeg
    legTapSV.value = !!onLegTap
    if (!legEnabledSV.value || !profile || profile.altitudeProfile.length === 0 || legSpanList.length === 0) {
      legSegsSV.value = []
      return
    }
    const line = plannedAltitudeLine(profile.altitudeProfile, profile.totalNm, perf, depElevFt, arrElevFt)
    const yClamp = (ft: number) => Math.min(MARGIN_T + plotH, Math.max(MARGIN_T + 2, yOf(ft)))
    const out: number[] = []
    for (let k = 0; k + 1 < line.length; k++) {
      const mid = (line[k].distNm + line[k + 1].distNm) / 2
      let leg = legSpanList.findIndex((s) => mid >= s.fromNm && mid <= s.toNm)
      if (leg < 0) leg = mid < legSpanList[0].fromNm ? 0 : legSpanList.length - 1
      out.push(leg, xOf(line[k].distNm), yClamp(line[k].altFt), xOf(line[k + 1].distNm), yClamp(line[k + 1].altFt))
    }
    legSegsSV.value = out
  }, [onLegLevelChange, levelEditLeg, onLegTap, profile, perf, depElevFt, arrElevFt, xOf, yOf, plotH, legSpanList, legEnabledSV, legSegsSV, legEditOnlySV, legTapSV])

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
  // The line runs on to the destination when the far marks lie beyond it.
  const trajectoryEndTick = useMemo(() => computeTrajectoryEndTick({
    currentDistNm, currentSpeedKts, timeMode: trajectoryMode === 'time',
    marks: [1, 3, trajectoryNm], totalNm,
  }), [currentDistNm, currentSpeedKts, trajectoryMode, trajectoryNm, totalNm])
  const vspeedTrajectory = useMemo(() => computeVspeedTrajectory({
    currentDistNm, currentAltFt, currentVSpeedFpm,
    ticks: trajectoryEndTick ? [...trajectoryTicks, trajectoryEndTick] : trajectoryTicks, getMsa,
  }), [currentDistNm, currentAltFt, currentVSpeedFpm, trajectoryTicks, trajectoryEndTick, getMsa])
  // (Pixel mapping and path strings: ownLayer below.)
  const trajectoryAttitudeColor =
    vspeedTrajectory.attitude === 'climb'   ? 'rgba(34,197,94,0.85)'  :
    vspeedTrajectory.attitude === 'descent' ? 'rgba(248,113,113,0.85)' :
                                             'rgba(255,255,255,0.55)'

  // Aircraft pitch tilt — nose up on climb, nose down on descent (visual flourish)
  // Follows the slope of the drawn trajectory line (shared with web), so the
  // symbol tilts as much as the line climbs or falls; level while the vertical
  // speed is unknown.
  const pitchDeg = useMemo(() => {
    const [a, b] = vspeedTrajectory.points
    return trajectoryPitchDeg(
      a && { x: xOf(a.distNm), y: yOf(a.altFt) }, b && { x: xOf(b.distNm), y: yOf(b.altFt) }, vspeedTrajectory.estimated,
    )
  }, [vspeedTrajectory, xOf, yOf])

  // Aircraft-dependent layer, drawn relative to the aircraft. react-native-svg
  // on Android re-rasterises an Svg into a fresh bitmap (in software, on the UI
  // thread) whenever any of its props change: with absolute coordinates that
  // happened on every position tick (~60 ms on the tablet for the full route
  // width). Here the Svg content only holds offsets from the aircraft, rounded
  // to whole pixels, and a plain wrapper View is moved instead: at steady speed,
  // altitude and vertical speed the Svg props stay identical, so a tick costs a
  // view move and no redraw.
  const ownLayer = useMemo(() => {
    if (currentDistNm == null) return null
    const ax  = xOf(currentDistNm)
    const PAD = 24
    const rx  = (x: number) => Math.round(x - ax) + PAD
    const ry  = (y: number) => Math.round(y * 2) / 2
    const ticks = trajectoryTickNms.map((d) => rx(xOf(d)))
    const pts = vspeedTrajectory.points.length >= 2
      ? vspeedTrajectory.points.map((p) => ({ x: rx(xOf(p.distNm)), y: ry(yOf(p.altFt)), below: p.below }))
      : []
    const segments = pts.slice(1).map((p, i) => ({
      path: `M${pts[i].x},${pts[i].y} L${p.x},${p.y}`,
      below: pts[i].below || p.below,
    }))
    const dots = pts.slice(1)
    const maxX = Math.max(PAD, ...ticks, ...dots.map((p) => p.x))
    return {
      left: ax - PAD,
      // Snapped so the Svg size does not change with small speed changes.
      w: Math.ceil((maxX + PAD) / 64) * 64,
      ticks, segments, dots,
      acX: PAD,
      acY: currentAltFt != null ? ry(yOf(currentAltFt)) : null,
      pitch: Math.round(pitchDeg),
    }
  }, [currentDistNm, currentAltFt, xOf, yOf, trajectoryTickNms, vspeedTrajectory, pitchDeg])

  // Category-shaped marker (fixed-wing/glider/helicopter/gyrocopter) instead
  // of always the same generic single-engine-airplane silhouette — see
  // aircraftSilhouette.ts header for why only these four groups exist.
  const silhouette = useMemo(
    () => getAircraftSilhouette(aircraftProfile?.category),
    [aircraftProfile?.category],
  )

  const onChartLayout = useCallback((e: LayoutChangeEvent) => {
    setChartW(e.nativeEvent.layout.width)
    chartWSV.value = e.nativeEvent.layout.width
  }, [chartWSV])



  const yTicks = useStableList(altitudeTicksFrom(yMax, yMin))
  // Round display-unit values (NM or km), converted back to NM for xOf.
  const unitPerNm = nmToDisplay(1, units.distance)
  const xTicks = useStableList(distanceTicks(totalNm * unitPerNm, Math.max(2, Math.round(plotW / X_TICK_SPACING_PX)), Math.min(0.5, 20 / Math.max(1, plotW))).map((v) => v / unitPerNm))

  // Wind row under the x axis (mirrors web's VirtualRadar): station barbs
  // (priority 0) beat ground-model barbs (priority 1); each keeps its route
  // position and degrades dir/kt text -> barb only -> not drawn when it would
  // overlap a tick label, another barb or the chart edge.
  type RowWind = { dirDeg: number | null; speedKt: number; calm: boolean }
  const windRow = useMemo(() => {
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
    // Barbs beat distance-tick labels; colliding labels are hidden instead
    // (mirrors web). The "0" label stays: minPx keeps barbs clear of it.
    const placed = layoutWindRow(items, {
      tickPx: [], minPx, maxPx, leftLimitPx: MARGIN_L, rightLimitPx: contentW - 2,
    })
    const tickLabelShown = tickLabelsClearOfWindRow(xTicks.map((d) => xOf(d)), items, placed)
      .map((clear, i) => clear || xTicks[i] === 0)
    return {
      barbs: placed.map((pl) => ({ ...pl, wind: winds.get(pl.key)!.wind, text: labelOf(winds.get(pl.key)!.wind), model: pl.key.startsWith('gr-') })),
      tickLabelShown,
    }
  }, [weatherMarks, windAloft, plotW, contentW, xOf, xTicks])

  if (!profile || profile.totalNm === 0) {
    // A flight log shows its panel at once: building its profile (map data, terrain) takes a moment.
    if (!logMode) return null
    return (
      <View style={[styles.panel, collapsed && styles.panelCollapsed]}>
        <View style={styles.dragHandle} {...panResponder.panHandlers}>
          <View style={styles.headerSide}><Text style={styles.logTitle}>FLIGHT LOG</Text></View>
          <View style={styles.dragGrip} />
          <View style={[styles.headerSide, styles.headerSideEnd]}>
            {onClose && (
              <TouchableOpacity style={styles.closeBtn} onPress={onClose} hitSlop={{ left: 8, right: 8 }} accessibilityLabel={closeLabel ?? 'Close'}>
                <Ionicons name="close" size={16} color={theme.textSecondary} />
              </TouchableOpacity>
            )}
          </View>
        </View>
        {!collapsed && (
          <View style={[styles.chartWrap, styles.flownLoading, { height: chartH }]}>
            <Text style={styles.flownLoadingTxt}>Building the profile along the flown track…</Text>
          </View>
        )}
      </View>
    )
  }  return (
    <View style={[styles.panel, collapsed && styles.panelCollapsed]}>
      {/* Drag handle + header merged into one compact row — title text and
          the separate header row were removed entirely to reclaim vertical
          space (distance is already visible via the X-axis; mode context
          [planned/look-ahead] wasn't worth a dedicated text row). The grip
          is absolutely centred so the WIND toggle can sit at the right edge
          of the same row without fighting it for layout space. */}
      <View style={styles.dragHandle} {...panResponder.panHandlers}>
        <View style={styles.headerSide}>
          {headerStart ?? (logMode ? (
            <Text style={styles.logTitle} numberOfLines={1}>
              FLIGHT LOG <Text style={styles.logDist}>{nmToDisplay(totalNm, units.distance).toFixed(1)} {distLabel(units.distance)}</Text>
              {flownDraw && flownDraw.gapInfo.count > 0 ? <Text style={styles.logWarn}>{`  ⚠ ${flownDraw.gapInfo.count} gap${flownDraw.gapInfo.count > 1 ? 's' : ''}, ${formatElapsed(flownDraw.gapInfo.largestMs)}`}</Text> : null}
              {flownDraw && flownDraw.entries > 0 ? `  · ${flownDraw.entries} airspace` : ''}
            </Text>
          ) : null)}
        </View>
        <View style={styles.dragGrip} />
        <View style={[styles.headerSide, styles.headerSideEnd]}>
          {headerEnd}
          {/* Winds aloft came back incomplete (Open-Meteo throttled or
              offline): say so instead of silently drawing fewer barbs.
              Mirrors web's VirtualRadar. */}
          {windOn && windAloftStatus !== 'ok' && (
            <Text style={styles.windStatusTxt} numberOfLines={1}>
              {windAloftStatus === 'retrying' ? 'Winds: retrying\u2026' : 'Winds unavailable'}
            </Text>
          )}
          {/* Zoom along the route is by pinching the chart; the −/+ buttons did nothing visible on most routes. */}
          <TouchableOpacity
            style={[styles.projBtn, showMsa && styles.projBtnOn]}
            onPress={() => setShowMsa(v => !v)}
            accessibilityLabel={showMsa ? 'Hide the minimum safe altitude line' : 'Show the minimum safe altitude line'}
          >
            <Text style={[styles.projBtnTxt, showMsa && styles.projBtnTxtOn]}>MSA</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.projBtn, showObstLabels && styles.projBtnOn]}
            onPress={() => setShowObstLabels(v => !v)}
            accessibilityLabel={showObstLabels ? 'Hide obstacle height labels' : 'Show height labels on the obstacles near your level'}
          >
            <Text style={[styles.projBtnTxt, showObstLabels && styles.projBtnTxtOn]}>OBST</Text>
          </TouchableOpacity>
          {logMode && (
            <TouchableOpacity
              style={[styles.projBtn, showSpeed && styles.projBtnOn]}
              onPress={() => setShowSpeed(v => !v)}
              accessibilityLabel={showSpeed ? 'Hide the ground-speed line' : 'Show the ground speed along the flight'}
            >
              <Text style={[styles.projBtnTxt, showSpeed && styles.projBtnTxtOn]}>{showSpeed && flownDraw ? `GS 0\u2013${flownDraw.speedTopKts}` : 'GS'}</Text>
            </TouchableOpacity>
          )}
          {!logMode && (
            <TouchableOpacity
              style={[styles.projBtn, showWindAloft && styles.projBtnOn]}
              onPress={() => setShowWindAloft(v => !v)}
            >
              <Text style={[styles.projBtnTxt, showWindAloft && styles.projBtnTxtOn]}>WIND</Text>
            </TouchableOpacity>
          )}
          {onClose && (
            <TouchableOpacity style={styles.closeBtn} onPress={onClose} hitSlop={{ left: 8, right: 8 }} accessibilityLabel={closeLabel ?? 'Close'}>
              <Ionicons name="close" size={16} color={theme.textSecondary} />
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
                // maxWidth: wraps on narrow screens instead of running off the chart.
                <View style={[styles.offTrackBadge, { top: MARGIN_T + 14 + (crossTrackNm != null && Math.abs(crossTrackNm) > OFF_TRACK_BADGE_NM ? 18 : 0), maxWidth: Math.max(120, chartW - MARGIN_L - MARGIN_R - 4) }]} pointerEvents="none">
                  <Text style={styles.offTrackTxt}>
                    {msaTerrain.fromGridOnly ? '⚠ No ground line: MSA from the terrain grid, AGL limits at raw height' : '⚠ No terrain data: MSA unavailable, AGL limits at raw height'}
                    {getOfflineDem() == null ? '. Download "Terrain elevation + hillshade" under Settings → Offline Data for ground without a connection.' : ''}
                  </Text>
                </View>
              )}
              {crossTrackNm != null && Math.abs(crossTrackNm) > OFF_TRACK_BADGE_NM && (
                // top sits just below the waypoint-name label row (MARGIN_T
                // + its own text height) rather than at top:2 alongside it —
                // that used to land directly on top of the
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
              <GestureDetector gesture={chartGesture}>
              <View style={{ width: chartW, height: chartH, overflow: 'hidden' }}>
              <Animated.View style={[{ width: contentW, height: chartH }, contentStyle]}>
              <Svg width={contentW} height={chartH}>
                <RadarBackdrop
                  profile={profile} terrainPts={terrainPts} corridorFill={corridorFill} terrainPath={terrainPath}
                  weatherMarks={weatherMarks} obstacleMarks={obstacleMarks} poiMarks={poiMarks}
                  xOf={xOf} yOf={yOf} yMin={yMin} yMax={yMax} plotW={plotW} plotH={plotH} plotBottom={plotBottom}
                  totalNm={totalNm} yTicks={yTicks} xTicks={xTicks}
                />

                <ProfileAStatic
                  xTicks={xTicks}
                  logMode={logMode}
                  flownDraw={flownDraw}
                  showSpeed={showSpeed}
                  flownPlannedPath={flownPlanned?.path ?? ''}
                  windAloft={windAloft}
                  arrElevFt={arrElevFt}
                  contentW={contentW}
                  depElevFt={depElevFt}
                  dragStore={dragStore}
                  dragging={dragging}
                  legFallbackAltFt={legFallbackAltFt}
                  legMsaFt={legMsaFt}
                  legSpanList={legSpanList}
                  msaPath={msaPath}
                  obstacleMarks={obstacleMarks}
                  pathSamples={pathSamples}
                  perf={perf}
                  phaseLayout={phaseLayout}
                  phaseMarks={phaseMarks}
                  plannedAltAt={plannedAltAt}
                  plannedPath={plannedPath}
                  plotH={plotH}
                  plotW={plotW}
                  poiMarks={poiMarks}
                  profile={profile}
                  projDangerPath={projDangerPath}
                  showMsa={showMsa}
                  totalNm={totalNm}
                  unreached={unreached}
                  windRow={windRow}
                  windXOf={windXOf}
                  xOf={xOf}
                  yMax={yMax}
                  yMin={yMin}
                  yOf={yOf}
                />

              </Svg>
              {/* Aircraft-dependent parts: own Svg in coordinates relative to the
                  aircraft (see ownLayer); the wrapper View moves, the Svg content
                  only changes when speed, altitude or vertical speed change. */}
              {ownLayer && (
              <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: ownLayer.w, height: chartH, transform: [{ translateX: ownLayer.left }] }}>
              <Svg width={ownLayer.w} height={chartH}>
                {/* ── Trajectory ticks ─────────────────────────────────── */}
                {ownLayer.ticks.map((x, i) => (
                  <SvgLine key={`traj-${i}`} x1={x} y1={MARGIN_T} x2={x} y2={MARGIN_T + plotH}
                    stroke="rgba(250,204,21,0.70)" strokeWidth={1} strokeDasharray="3,3" />
                ))}

                {/* ── Vertical-speed-aware trajectory line ────────────────
                     Climb/descent/level colour follows the *current* vspeed,
                     linearly extrapolated to each distance tick above —
                     distinct from the yellow dashed distance/time ticks
                     (which stay purely horizontal reference marks) and from
                     the planned line's performance-model path (which
                     models the level-off/climb schedule from departure;
                     this one follows the live vertical speed). */}
                {ownLayer.segments.map((seg, i) => (
                  <Path key={`trajseg-${i}`} d={seg.path} fill="none"
                    stroke={seg.below ? DANGER_COLOR : trajectoryAttitudeColor}
                    strokeWidth={seg.below ? 2.25 : 1.75} strokeDasharray="1,2" opacity={vspeedTrajectory.estimated ? 0.6 : 1} />
                ))}
                {ownLayer.dots.map((p, i) => (
                  <Circle key={`trajdot-${i}`} cx={p.x} cy={p.y} r={p.below ? 3 : 2.5}
                    fill={p.below ? DANGER_COLOR : trajectoryAttitudeColor} opacity={vspeedTrajectory.estimated ? 0.6 : 1} />
                ))}

                {/* ── Live position marker + aircraft silhouette ──────── */}
                <SvgLine x1={ownLayer.acX} y1={MARGIN_T} x2={ownLayer.acX} y2={MARGIN_T + plotH}
                  stroke="rgba(255,255,255,0.40)" strokeWidth={1} strokeDasharray="3,3" />
                {ownLayer.acY != null && (
                  <G transform={`translate(${ownLayer.acX}, ${ownLayer.acY}) rotate(${-ownLayer.pitch})`}>
                    <Circle r={13} fill="rgba(34,197,94,0.18)" />
                    {silhouette.map((part, i) => (
                      <Path key={`ac-part-${i}`} d={part.d} fill={part.fill ?? '#ffffff'} fillOpacity={part.opacity} />
                    ))}
                  </G>
                )}
              </Svg>
              </View>
              )}
              {flown && (
                <FlownAircraft store={flownStore} flown={flown} xOf={xOf} yOf={yOf} yMin={yMin} yMax={yMax} silhouette={silhouette} acX={acXSV} acY={acYSV} />
              )}

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
                <ProfileCStatic
                  chartH={chartH}
                  contentW={contentW}
                  landmarkMarks={landmarkMarks}
                  obstacleMarks={obstacleMarks}
                  poiMarks={poiMarks}
                  profile={profile}
                  styles={styles}
                  totalNm={totalNm}
                  visibleWaypointTicks={logMode ? NO_WAYPOINT_TICKS : visibleWaypointTicks}
                  xOf={xOf}
                  yMax={yMax}
                  yOf={yOf}
                />

                {trajectoryTickNms.map((d, i) => (
                  <Text key={`trajl-${i}`} style={[styles.trajLabel, { left: xOf(d) - 8, top: MARGIN_T - 10 }]}>
                    {trajectoryTickLabels[i]}
                  </Text>
                ))}

                <ProfileDStatic
                  contentW={contentW}
                  plotH={plotH}
                  styles={styles}
                  units={units}
                  windRow={windRow}
                  xOf={xOf}
                  xTicks={xTicks}
                />
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
              {flown && <FlownReadout store={flownStore} flown={flown} bands={profile.airspaceBands} terrainPts={terrainPts} getMsa={getMsa} styles={styles} xOf={xOf} scrollXRef={scrollXRef} viewportW={chartW} planned={flownPlanned} />}
              </View>
              </GestureDetector>
              {/* Pinned Y-axis tick labels — rendered outside the scrollable
                  clip window (above) so they stay fixed at the left edge
                  regardless of scrollX, instead of scrolling away with the
                  route content like everything else in this chart does.
                  Opaque panel-coloured backing (the sky starts at the axis line, as on web) from just above the top tick
                  down: scrolled content (airspace, chips, clouds, terrain,
                  x-axis labels) disappears at the axis line instead of
                  sliding underneath the FL labels. The wind/waypoint row
                  above stays uncovered -- nothing pinned sits there. */}
              <View style={styles.yAxisPinned} pointerEvents="none">
                <Svg style={StyleSheet.absoluteFill} width={MARGIN_L} height={chartH}>
                  <Rect x={0} y={AXIS_COVER_TOP} width={MARGIN_L} height={chartH - AXIS_COVER_TOP} fill={theme.surfacePanel} />
                  <SvgLine x1={MARGIN_L - 0.5} y1={AXIS_COVER_TOP} x2={MARGIN_L - 0.5} y2={MARGIN_T + plotH}
                    stroke="rgba(255,255,255,0.3)" strokeWidth={1} />
                </Svg>
                {yTicks.map((ft, i) => (
                  <Text key={`yl-${i}`} style={[styles.axisLabel, { left: 2, top: yOf(ft) - 7 }]}>
                    {formatAltitudeTick(ft)}
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
  // 30 (was 22): the row also hosts tappable controls (ruler clear, WIND),
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
  closeBtn: {
    borderWidth:       1,
    borderColor:       theme.borderStrong,
    borderRadius:      theme.radiusSm,
    backgroundColor:   theme.surfaceHover,
    // Fills the 30 dp header row; hitSlop only widens it sideways since the
    // row's own bounds cap touch height on Android.
    minWidth:          36,
    height:            26,
    alignItems:        'center',
    justifyContent:    'center',
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
  logTitle: {
    color:      theme.textSecondary,
    fontSize:   10,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  logWarn: {
    color:      theme.statusWarn,
    fontWeight: '700',
  },
  logDist: {
    color:      FLOWN_COLOR,
    fontWeight: '700',
  },
  // Readout of the inspected flight-log point. Always dark: it sits on the chart, which is
  // dark in every theme, and its labels use the chart's line colours.
  flownReadoutRow: {
    position:      'absolute',
    top:           MARGIN_T + 2,
    left:          MARGIN_L + 4,
    right:         4,
    flexDirection: 'row',
  },
  flownReadout: {
    backgroundColor: 'rgba(12,16,26,0.92)',
    borderColor:     'rgba(255,255,255,0.22)',
    borderWidth:     1,
    borderRadius:    4,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  flownRow: {
    flexDirection: 'row',
    alignItems:    'baseline',
  },
  flownLabel: {
    color:      '#b8c0cc',
    fontSize:   9,
    fontWeight: '700',
    minWidth:   32,
  },
  flownValue: {
    color:      '#e8edf5',
    fontSize:   11,
    fontWeight: '600',
  },
  flownLoading: {
    alignItems:     'center',
    justifyContent: 'center',
  },
  flownLoadingTxt: {
    color:    theme.textSecondary,
    fontSize: 12,
  },
  flownHint: {
    color:      '#e8edf5',
    fontSize:   10,
  },
  windStatusTxt: {
    color:      theme.textSecondary,
    fontSize:   9,
    fontWeight: '600',
    marginRight: theme.space2,
  },
  chartWrap: {},
  wpLabel: {
    position: 'absolute',
    color:    '#fff',
    fontSize: WP_LABEL_FONT,
    fontWeight: '600',
    maxWidth: 60,
    textShadowColor: 'rgba(0,0,0,0.9)', textShadowRadius: 3, textShadowOffset: { width: 0, height: 0 },
  },
  trajLabel: {
    position: 'absolute',
    color:    'rgba(250,204,21,0.90)',
    fontSize: 9,
    fontWeight: '600',
  },
  axisLabel: {
    position: 'absolute',
    color:    'rgba(255,255,255,0.8)',
    fontSize: AXIS_FONT,
  },
  axisLabelX: {
    position: 'absolute',
    color:    'rgba(255,255,255,0.8)',
    fontSize: AXIS_FONT,
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
