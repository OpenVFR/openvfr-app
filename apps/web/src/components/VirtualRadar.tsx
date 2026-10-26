import { useChartH } from '../utils/vrChartHeight'
import { usePersistedFlag } from '../utils/usePersistedFlag'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState, useRef, type ReactNode } from 'react'
import {
  pickWaypointLabels, waypointLabelWidth, placeLabels, placeRadarLabels, mergeNearbyLabels, obstacleLabelWidth, poiLabelWidth, OBSTACLE_LABEL_H, POI_LABEL_H,
  type BoxRect, type LabelRequest, type PlacedLabel,
} from '@open-vfr/shared/profileLabels'
import {
  symbolGroundY, LIMITING_LABEL_MERGE_PX, POI_SCALE, poiCenterY, SKY_TOP, SKY_BOTTOM, PLAN_COLOR, MSA_COLOR, GROUND_COLOR, GROUND_OUTLINE, CORRIDOR_FILL, CORRIDOR_OUTLINE, CORRIDOR_OUTLINE_WIDTH,
  DANGER_COLOR, DANGER_TEXT, PHASE_SHORT_COLOR, WIND_LABEL_COLOR, windAloftFit, terrainGradientStops, phaseLabelText,
  FLOWN_COLOR, FLOWN_GAP_COLOR, FLOWN_SPEED_COLOR, FLOWN_NEAR_FIELD_COLOR, FLOWN_NEAR_FIELD_NM,
} from '@open-vfr/shared/radarStyle'
import {
  flownAltitudeAt, flownIndexAt, flownLineParts, formatElapsed, formatUtcTime, flownGaps, flownSpeedScale, flownSpeedRuns,
  flownAirspaceAt, flownAirspaceEntries, splitBelowMsaNearFields, type FlownPoint,
} from '@open-vfr/shared/flightLogProfile'
import { airspaceOutlines, airspaceChips, layoutAirspaceChips } from '@open-vfr/shared/airspaceOutline'
import {
  cloudLayerPaths, cloudLayerLabel, cloudGlyphHeight, cloudOpacityForOffset, cloudReportOffRouteNm,
  cloudReportIcao, cloudStripHalfWidthNm, placeCloudLabel, type LabelRect,
} from '@open-vfr/shared/cloudGlyph'
import { CLOUD_COLORS } from '@open-vfr/shared/featureColors'
import type { ParsedCloudLayer } from '@open-vfr/shared/fetchWx'
import {
  profileChartLayout, clampProfileZoom, scrollAfterZoom, profileYMax, profileYMin, liveAltitudeWindow, altitudeTicksFrom, formatAltitudeTick, formatAltitudeFt, distanceTicks,
  polylinePath, groundAreaPath, belowMsaRuns, nearestSampleIndex, declutterMarks, obstacleOpacity, isLimitingObstacle, waterBandTopFt, type ProfileChartLayout,
} from '@open-vfr/shared/profileChart'
import type { RouteWaypoint } from '../utils/routeCalc'
import { useMsaMargins } from '../db/useSettings'
import { resolveMsaMargins } from '@open-vfr/shared/msaMargins'
import { collectRoutePois, poiBaseFt } from '@open-vfr/shared/routePois'
import { fetchTerrainProfileShared } from '@open-vfr/shared/terrainCache'
import { carryLookaheadTerrain } from '@open-vfr/shared/lookaheadTerrain'
import { obstacleSymbol, polyPath, primStyle, obstacleXScale, MIN_FULL_HEIGHT_PX, type SymbolPrim } from '@open-vfr/shared/obstacleSymbol'
import { effectiveHeight, obstacleTipsForMsa, limitingObstacleLabel, FT_PER_M } from '@open-vfr/shared/obstacleHeights'
import { legSpans, legMsaList, legBelowMsa, dragShownFt, withLegLevel, altAtY, unreachedLegs, verticalPhaseMarks, LEVEL_STEP_FT, DRAG_MIN_MOVE_PX, type LegSpan } from '@open-vfr/shared/legLevelDrag'
import { useMefGrids } from '../hooks/useMefGrids'
import type { LegOverride } from '../db/index'
import { type Units, DEFAULT_UNITS, nmToDisplay, distLabel } from '../utils/units'
import {
  buildVirtualRadarProfile, applyTerrainToBands, projectFlightPath, DEFAULT_PERF_MODEL, computeMsaProfile, terrainAt,
  getMsaLookup, corridorTerrainAlongRoute, legCorridorMsaFt, terrainForMsa, computeTrajectoryTicks, computeTrajectoryEndTick, computeVspeedTrajectory, trajectoryPitchDeg, projectWeatherMarks,
  type TerrainPoint, type MsaPoint, type AircraftPerfModel,
} from '@open-vfr/shared/virtualRadarCalc'
import { resolveStationWeather } from '@open-vfr/shared/parseTaf'
import { getRemoteDem } from '../utils/terrainDem'
import { API_BASE_URL } from '../utils/env'
import { windBarbColorForSpeed, windBarbGeometry } from '@open-vfr/shared/windBarb'
import type { AircraftProfileDocType } from '../db/index'
import type { RouteWeatherStation } from '../hooks/useWeatherAlongRoute'
import { layoutWindRow, tickLabelsClearOfWindRow, type WindRowItem } from '@open-vfr/shared/windRow'
import { useWindAloftAlongRoute } from '../hooks/useWindAloftAlongRoute'
import css from './VirtualRadar.module.css'
import { loadCountryGeojson } from '@open-vfr/shared/countryData'
import { useActiveCountries } from '../utils/countryData'
import { OBSTACLE_ICON_DEFS, OBSTACLE_ICON_FALLBACK_DEF } from '../utils/obstacleIcons'
import { LANDMARK_ICON_DEFS } from '../utils/landmarkIcons'
import { loadColoredSvgMarkup } from '../utils/svgIconLoader'
import { getAircraftSilhouette } from '@open-vfr/shared/aircraftSilhouette'

// Don't compress a long route down to fit the panel width: below this
// pixel density (per display unit, NM or km) the chart becomes horizontally
// scrollable instead, matching native's MIN_PX_PER_NM in VerticalProfile.tsx.
// 30 rather than a lower value: at 18 almost any panel fitted a 40-50 NM
// route, so the scroll path never activated even though waypoint and wind
// labels were visibly cramped well before that.
const MIN_PX_PER_UNIT = 30
// Cross-track deviation beyond which the chart badges itself as showing a
// route the aircraft is no longer actually on — matches native's constant.
const OFF_TRACK_BADGE_NM = 3

// ── Chart geometry ───────────────────────────────────────────────────────────
// The chart is plain SVG drawn from @open-vfr/shared/profileChart (the same
// scales and ticks native's VerticalProfile uses). Left margin = 4 px gutter
// + 36 px altitude-label column; bottom margin = distance-tick band, which
// the wind row shares.
const MARGIN = { top: 8, right: 12, bottom: 32, left: 40 }
/** Chart svg height implied by a layout (the user can resize the chart). */
const chartHeightOf = (L: { plotBottom: number }) => L.plotBottom + MARGIN.bottom
/** Centre of the wind row, px below the plot bottom (inside the x-axis band). */
const WIND_ROW_Y = 15
// Edge barbs are nudged this far in from the plot edges (px): clears the "0"
// tick label on the left and the "NM" unit label on the right.
const WIND_ROW_EDGE_L_PX = 16
const WIND_ROW_EDGE_R_PX = 30
/** Station barbs closer than this to a ground-model column replace it (observed beats model). */
const WIND_ROW_STATION_SEP_NM = 6
/** Winds-aloft barbs are kept this far (px) inside the plot edges. */
const WIND_ALOFT_EDGE_PX = 24
/** Roughly one distance tick per this many px of plot width. */
const X_TICK_SPACING_PX = 100
/** Waypoint / trajectory label inset from its line (px). */
const LINE_LABEL_INSET = 5

// Text and guide lines drawn inside the plot: the chart is dark in every theme, so these are
// fixed light colours, not the theme's (dark in the light theme). Axes outside the plot follow the theme.
const CHART_TEXT = '#ffffff'
const CHART_LINE = 'rgba(255,255,255,0.45)'

const HALO = { stroke: 'rgba(0,0,0,0.9)', strokeWidth: 4, strokeLinejoin: 'round' as const, paintOrder: 'stroke' }


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  waypoints:    RouteWaypoint[]
  legOverrides: LegOverride[]
  units?:       Units
  /** Optional label shown in the header instead of 'VIRTUAL RADAR' */
  title?: string
  /** Called when user hovers profile — passes NM along route (null = no hover) */
  onHoverDistNm?: (distNm: number | null) => void
  /** Optional selected aircraft profile — enables projected flight path overlay */
  aircraftProfile?: AircraftProfileDocType
  /** NM along the route where the aircraft currently is — enables the live position marker */
  currentDistNm?: number
  /** Current GPS altitude AMSL in feet — shown as the aircraft silhouette on the marker line */
  currentAltFt?: number
  /** Current GPS ground speed in kts — used to compute time-mode trajectory tick distances */
  currentSpeedKts?: number
  /** Current vertical speed in ft/min — drives the climb/descent-aware
   *  trajectory line (see computeVspeedTrajectory). Web has no baro/vario
   *  sensor access, so this is typically a GPS-altitude-derived estimate
   *  (see useGpsVerticalSpeed) rather than native's baro/vario-tiered value
   *  — treat as indicative only. */
  currentVSpeedFpm?: number
  /** Same ceiling filter as the map's airspace layers (settings.airspaceCeilingFt)
   *  -- airspace bands whose floor is above this are hidden from the chart,
   *  matching what's already hidden on the map. Unfiltered if omitted. */
  airspaceCeilingFt?: number
  /** Matches the map trajectory mode: 'time' = marks at 1/3/5 min ahead, 'dist' = 1/3/5 NM ahead */
  trajectoryMode?: 'time' | 'dist'
  /** NM along the route for a map-driven crosshair cursor (null = hidden) */
  crosshairDistNm?: number | null
  /** Lateral (cross-track) distance in NM between the aircraft and the
   *  planned route line — see routeCrossTrackNm in virtualRadarCalc. Mirrors
   *  native's identical prop; omit to suppress the badge entirely. */
  crossTrackNm?: number
  /** METAR/TAF stations along the route (from useWeatherAlongRoute) — wind
   *  arrows and cloud-base layers drawn at each station's projected
   *  along-route position. Omit to hide entirely. */
  weatherStations?: RouteWeatherStation[]
  /** Enables dragging a leg up/down to change its planned level. `null` clears
   *  the leg's override (route level). Omit while the route is locked. */
  onLegLevelChange?: (legIndex: number, altFt: number | null) => void
  /** The chart follows the aircraft's altitude (no planned route: look-ahead). The scale is
   *  a window around the aircraft instead of fitting a plan. */
  followAircraft?: boolean
  /** Draw the band of highest ground within the abeam distance behind the ground line
   *  (default true). Off for the ruler and the look-ahead: only a planned route has a
   *  corridor the pilot set out to fly. The MSA still uses it either way. */
  corridorBand?: boolean
  /** Flight-log review: `waypoints` is the simplified recorded track and these are the recorded
   *  points along it (see @open-vfr/shared/flightLogProfile). The chart then draws the flown
   *  altitude instead of a plan (no leg editing, no forecast winds) and the hover readout gives
   *  time, altitude and ground speed at the recorded point under the cursor. */
  flown?: FlownPoint[]
  /** Shows a close button in the header. */
  onClose?: () => void
  /** Flight log: inspect the recorded point closest to this time (an event picked in the Logs list); `n` makes a repeat pick count. */
  jumpToTs?: { ts: number; n: number } | null
}

/** Per-sample series the chart lines and the hover readout are drawn from. */
interface ProfileSeries {
  distNms:     number[]
  plannedAlts: number[]
  /** Terrain elevation per sample; null while terrain is loading / unavailable. */
  ground:      number[] | null
  /** MSA per sample (0 = none). */
  msa:         number[] | null
  belowMsa:    { distNm: number; altFt: number }[][]
  /** Flight log: below-MSA stretches near an aerodrome (departure, arrival), drawn softer. */
  belowMsaNearField?: { distNm: number; altFt: number }[][]
}

interface CloudMark {
  distNm: number
  offRouteNm: number
  station: RouteWeatherStation
  clouds: ParsedCloudLayer[]
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

/**
 * Renders a small WMO-style wind barb (shaft + pennant/full/half-barb
 * feathers) at the origin, pointing "up" before the caller's own rotate()
 * -- same geometry/reading convention as the map's wind-barb icons (see
 * @open-vfr/shared/windBarb's windBarbGeometry), just scaled down for this
 * chart. A dark outline pass is drawn underneath the coloured pass, same
 * contrast fix as the map icon, so it stays legible on both basemaps.
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
    <g key={key}>
      <line x1={shaft.x1} y1={shaft.y1} x2={shaft.x2} y2={shaft.y2} stroke={stroke} strokeWidth={width} strokeLinecap="round" />
      {feathers.map((f, idx) =>
        f.kind === 'line' ? (
          <line key={idx} x1={f.x1} y1={f.y1} x2={f.x2} y2={f.y2} stroke={stroke} strokeWidth={width} strokeLinecap="round" />
        ) : (
          <path
            key={idx}
            d={`M${f.points[0][0]},${f.points[0][1]} L${f.points[1][0]},${f.points[1][1]} L${f.points[2][0]},${f.points[2][1]} Z`}
            fill={fill}
          />
        ),
      )}
    </g>
  )

  return (
    <>
      {renderPass(outlineColor, outlineColor, outlineW, 'outline')}
      {renderPass(color, color, strokeW, 'main')}
    </>
  )
}

/** A barb (or calm ring) centred on (cx, cy). */
function renderBarbAt(cx: number, cy: number, dirDeg: number, speedKt: number, calm: boolean) {
  const shaftLen = 16
  if (calm) return <circle cx={cx} cy={cy} r={3} fill="none" stroke="rgba(148,163,184,0.8)" strokeWidth={1} />
  return (
    <g transform={`translate(${cx},${cy}) rotate(${dirDeg}) translate(0, ${shaftLen / 2})`}>
      {renderWindBarbShape(speedKt, windBarbColorForSpeed(speedKt), { shaftLen, barbLen: 7, halfLen: 4, barbGap: 4, strokeW: 1.5 })}
    </g>
  )
}

/** Recoloured map pictogram anchored by its BOTTOM edge at (cx, cy), so it
 *  only ever grows upward from its data point (a centred or top-anchored icon
 *  on a zero-height obstacle or a landmark at ground level drew below 0 ft). */
/** Which obstacle shape a landmark kind is drawn as when it is tall enough. */
const LANDMARK_SHAPE_KIND: Record<string, string> = {
  church: 'building', mast: 'tower', chimney: 'chimney', water_tower: 'water_tower', windmill: 'tower',
}

/** SVG for the primitives of obstacleSymbol(); `dash` primitives (assumed height) are dashed. */
function renderShape(shape: SymbolPrim[]): ReactNode {
  return shape.map((p, k) => {
    if (p.t === 'rect') {
      const st = primStyle(p)
      return <rect key={k} x={p.x} y={p.y} width={p.w} height={p.h} fill={st.fill} fillOpacity={st.fillOpacity} stroke={st.stroke} strokeWidth={1} />
    }
    if (p.t === 'poly') {
      const st = primStyle(p)
      return <path key={k} d={polyPath(p.pts)} fill={st.fill} fillOpacity={st.fillOpacity} stroke={st.stroke} strokeWidth={1} />
    }
    if (p.t === 'line') return <line key={k} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke={p.stroke} strokeWidth={p.w} strokeLinecap="round" />
    return <circle key={k} cx={p.cx} cy={p.cy} r={p.r} fill={p.fill} />
  })
}

/** Aerodrome / navaid / reporting-point symbol; `halo` = the dark outline pass drawn first. */
function renderPoiSymbol(m: { kind: string; subtype: string; towered: boolean; cx: number; cy: number }, halo: boolean) {
  const stroke = halo ? 'rgba(0,0,0,0.8)' : '#fff'
  const sw = halo ? 4 : 1.25
  const col = (c: string) => (halo ? 'rgba(0,0,0,0.8)' : c)
  if (m.kind === 'aerodrome') {
    return m.subtype === 'HP'
      ? <rect x={m.cx - 4} y={m.cy - 4} width={8} height={8} rx={1.5} fill={col('#f472b6')} stroke={stroke} strokeWidth={sw} />
      : <circle cx={m.cx} cy={m.cy} r={5} fill={col(m.towered ? '#c084fc' : '#60a5fa')} stroke={stroke} strokeWidth={sw} />
  }
  if (m.kind === 'navaid') return <path d={`M${m.cx},${m.cy - 5} L${m.cx + 5},${m.cy} L${m.cx},${m.cy + 5} L${m.cx - 5},${m.cy} Z`} fill={col('#34d399')} stroke={stroke} strokeWidth={sw} />
  if (m.kind === 'reporting') return <path d={`M${m.cx},${m.cy - 5} L${m.cx + 4.5},${m.cy + 3} L${m.cx - 4.5},${m.cy + 3} Z`} fill={col('#facc15')} stroke={stroke} strokeWidth={sw} />
  return null
}

function renderIconAt(key: string, cx: number, cy: number, size: number, markup: string | undefined, fallback: ReactNode) {
  if (!markup) return <g key={key}>{fallback}</g>
  return (
    <g
      key={key}
      transform={`translate(${cx - size / 2},${cy - size})`}
      dangerouslySetInnerHTML={{ __html: markup.replace('<svg', `<svg width="${size}" height="${size}"`) }}
    />
  )
}

/** Airspace bands per style (see @open-vfr/shared/airspaceOutline): the area is
 *  filled once, and every sector keeps its own border except pieces lying inside
 *  another sector of the same kind (a higher floor drawn through a lower one).
 *  Band tops are clamped to yMax: a band topping above the scale, e.g. a TMA
 *  capped at FL065 over a low route, must still draw. */
function renderAirspace(bands: Parameters<typeof airspaceOutlines>[0], L: ProfileChartLayout) {
  return airspaceOutlines(bands, L.yMax).map((shape, i) => {
    const fillD = shape.loops
      .map((loop) => 'M' + loop.map(([nm, ft]) => `${L.xOf(nm)},${L.yOf(ft)}`).join('L') + 'Z')
      .join(' ')
    const lineD = shape.segments
      .map(([x1, y1, x2, y2]) => `M${L.xOf(x1)},${L.yOf(y1)}L${L.xOf(x2)},${L.yOf(y2)}`)
      .join(' ')
    const innerD = (shape.innerFloors ?? [])
      .map(([x1, y1, x2, y2]) => `M${L.xOf(x1)},${L.yOf(y1)}L${L.xOf(x2)},${L.yOf(y2)}`)
      .join(' ')
    return (
      <g key={`band-${i}`}>
        {/* Faint interior so the sky shows through; the edge band and a dark-edged border carry the shape. */}
        <path d={fillD} fill={shape.fill} fillOpacity={0.4} fillRule="evenodd" />
        {/* Wide band hugging the inside of the edges (line clipped to the area). */}
        <clipPath id={`airspace-clip-${i}`}><path d={fillD} fillRule="evenodd" /></clipPath>
        <path d={lineD} fill="none" stroke={shape.border} strokeWidth={12} strokeOpacity={0.55} clipPath={`url(#airspace-clip-${i})`} />
        {/* Dark outline under the border: separates it from a sky of any hue. */}
        <path d={lineD} fill="none" stroke="rgba(0,0,0,0.75)" strokeWidth={3.5} strokeLinecap="square" />
        <path d={lineD} fill="none" stroke={shape.border} strokeWidth={1.5} strokeLinecap="square" />
        {/* A sector's floor inside a lower sector of the same style: drawn like its side walls
            (same wide inner band, only on the airspace side = above the floor, and a solid border). */}
        {innerD && (
          <>
            <clipPath id={`inner-clip-${i}`}>
              {(shape.innerFloors ?? []).map(([x1, y1, x2], k) => (
                <rect key={k} x={L.xOf(x1)} y={L.yOf(y1) - 20} width={L.xOf(x2) - L.xOf(x1)} height={20} />
              ))}
            </clipPath>
            <path d={innerD} fill="none" stroke={shape.border} strokeWidth={12} strokeOpacity={0.55} clipPath={`url(#inner-clip-${i})`} />
            <path d={innerD} fill="none" stroke="rgba(0,0,0,0.75)" strokeWidth={3.5} strokeLinecap="square" />
            <path d={innerD} fill="none" stroke={shape.border} strokeWidth={1.5} strokeLinecap="square" />
          </>
        )}
      </g>
    )
  })
}

/** Label chips at the top-left corner of each airspace band: class letter (or
 *  designator) in a coloured cell, then the first radio frequency, laid out
 *  so neighbouring sectors' chips never cover each other. */
function renderAirspaceChips(placed: ReturnType<typeof layoutAirspaceChips>) {
  return (
    <g pointerEvents="none">
      {placed.map((p, i) => {
        const { chip: c, px: x, py: y, tagW, freqW, w, h } = p
        return (
          <g key={i}>
            <rect x={x} y={y} width={w} height={h} fill="#fff" stroke={c.border} strokeWidth={1} rx={1.5} />
            <rect x={x} y={y} width={tagW} height={h} fill={c.border} rx={1.5} />
            <text x={x + tagW / 2} y={y + 10.5} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="#fff">{c.tag}</text>
            {p.showFreq && <text x={x + tagW + freqW / 2} y={y + 10.5} textAnchor="middle" fontSize={9.5} fontWeight={600} fill="#111">{c.freq}</text>}
          </g>
        )
      })}
    </g>
  )
}

/** Weather: one cloud glyph per METAR/TAF cloud group
 *  (@open-vfr/shared/cloudGlyph): flat bottom at the reported base, lumpy
 *  tops of fixed pixel height (tops aren't reported, so they mean no
 *  altitude), cover shown as how much of the station's strip holds cloud,
 *  CB/TCU as a tower/anvil in a warning colour. Drawn across a fixed-width
 *  strip around the station (a point observation) rather than interpolated
 *  between stations. Reports taken far off the route fade out, then drop.
 *  Labels avoid the airspace chips and each other. Same geometry as
 *  native's VerticalProfile. */
function renderClouds(marks: CloudMark[], chips: ReturnType<typeof layoutAirspaceChips>, L: ProfileChartLayout, otherLabels: LabelRect[] = []) {
  const taken: LabelRect[] = [...chips.map((p) => ({ x: p.px, y: p.py, w: p.w, h: p.h })), ...otherLabels]
  const halfWidthNm = cloudStripHalfWidthNm(L.totalNm)
  const shapes: ReactNode[] = []
  const labels: ReactNode[] = []
  marks.forEach((m, i) => {
    const opacity = cloudOpacityForOffset(cloudReportOffRouteNm(m.offRouteNm, m.station))
    if (opacity === 0) return
    const x1 = L.xOf(Math.max(0, m.distNm - halfWidthNm))
    const x2 = L.xOf(Math.min(L.totalNm, m.distNm + halfWidthNm))
    const cx = (x1 + x2) / 2
    m.clouds.forEach((c, j) => {
      const yb = L.yOf(c.baseFt)
      if (yb < L.plotTop + 4) return  // base above the plotted range
      const accent = c.type === 'CB' ? CLOUD_COLORS.cb : c.type === 'TCU' ? CLOUD_COLORS.tcu : null
      cloudLayerPaths(x1, x2, yb, c, i * 7 + j, yb - L.plotTop).forEach((d, k) => shapes.push(
        <path key={`cloud-${i}-${j}-${k}`} d={d} opacity={opacity}
          fill={accent ? 'url(#cloudGradConvective)' : 'url(#cloudGrad)'}
          stroke={accent ?? CLOUD_COLORS.stroke} strokeWidth={accent ? 1.25 : 0.75} />,
      ))
      const text = cloudLayerLabel(c) + (j === 0 ? ` ${cloudReportIcao(m.station)}` : '')
      const glyphH = Math.min(cloudGlyphHeight(c), yb - L.plotTop)
      const y = placeCloudLabel(cx, yb, glyphH, text, taken, L.plotTop, L.plotBottom, 11 / 9)
      labels.push(
        <text key={`cloud-label-${i}-${j}`} x={Math.max(L.plotLeft + text.length * 3.2, Math.min(L.plotRight - text.length * 3.2, cx))} y={y} textAnchor="middle" fontSize={11} opacity={opacity}
          fill={accent ?? CLOUD_COLORS.label} {...HALO}>
          {text}
        </text>,
      )
    })
  })
  return <g pointerEvents="none">{shapes}{labels}</g>
}

/** Altitude axis: line on the plot's left edge plus labels in feet (QNH
 *  altitude, see formatAltitudeTick). Drawn in the chart and again in the
 *  pinned column while the chart scrolls. */
function renderYAxis(L: ProfileChartLayout, yTicks: number[]) {
  return (
    <g>
      <line x1={L.plotLeft} y1={L.plotTop} x2={L.plotLeft} y2={L.plotBottom} stroke="var(--border-default)" />
      {yTicks.map((ft) => (
        <text key={ft} x={L.plotLeft - 8} y={L.yOf(ft)} dy="0.355em" textAnchor="end" fontSize={11} fill="var(--text-secondary)">
          {formatAltitudeTick(ft)}
        </text>
      ))}
    </g>
  )
}

// ---------------------------------------------------------------------------
// Hover readout
// ---------------------------------------------------------------------------


/**
 * Pointer cursor + value readout (planned altitude, MSA, ground) at the
 * nearest profile sample. Owns its own state so moving the pointer only
 * re-renders this overlay, never the chart underneath; also reports the
 * hovered distance to the parent (map crosshair) once per sample change.
 */
const HoverOverlay = memo(function HoverOverlay({ layout: L, series, onHoverDistNm }: {
  layout: ProfileChartLayout
  series: ProfileSeries
  onHoverDistNm?: (distNm: number | null) => void
}) {
  const [idx, setIdx] = useState<number | null>(null)
  const lastIdxRef = useRef<number | null>(null)
  const onHoverRef = useRef(onHoverDistNm)
  onHoverRef.current = onHoverDistNm

  const update = useCallback((next: number | null) => {
    if (next === lastIdxRef.current) return
    lastIdxRef.current = next
    setIdx(next)
    onHoverRef.current?.(next == null ? null : series.distNms[next])
  }, [series])

  // A new series invalidates the sample index.
  useEffect(() => () => { lastIdxRef.current = null; setIdx(null) }, [series])

  // Listen on the chart container (the layer's parent), not on this layer: the leg drag
  // layer sits on top and its hit area around the planned level line swallows pointer
  // events, so hovering ON the planned path never reached this layer (no readout, no map
  // marker). Events from that layer bubble up to the container.
  const layerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = layerRef.current?.parentElement
    if (!host) return
    const move = (e: PointerEvent) => {
      const px = e.clientX - host.getBoundingClientRect().left
      if (px < L.plotLeft || px > L.plotRight) { update(null); return }
      update(nearestSampleIndex(series.distNms, L.nmAtX(px)))
    }
    const leave = () => update(null)
    host.addEventListener('pointermove', move)
    host.addEventListener('pointerleave', leave)
    return () => { host.removeEventListener('pointermove', move); host.removeEventListener('pointerleave', leave) }
  }, [L, series, update])

  let content: ReactNode = null
  if (idx != null && idx < series.distNms.length) {
    const x = L.xOf(series.distNms[idx])
    const rows: { label: string; ft: number; color: string }[] = []
    const plan = series.plannedAlts[idx]
    const msa = series.msa?.[idx] ?? 0
    const gnd = series.ground?.[idx] ?? 0
    if (plan > 0) rows.push({ label: 'Plan', ft: plan, color: PLAN_COLOR })
    if (msa > 0) rows.push({ label: 'MSA', ft: msa, color: MSA_COLOR })
    if (gnd > 0) rows.push({ label: 'GND', ft: gnd, color: GROUND_COLOR })
    rows.sort((a, b) => b.ft - a.ft)
    const flip = x > L.contentW - 110
    content = (
      <>
        <svg className={css.hoverSvg} width={L.contentW} height={chartHeightOf(L)} aria-hidden>
          <line x1={x} y1={L.plotTop} x2={x} y2={L.plotBottom} stroke={CHART_LINE} strokeWidth={1} />
          {rows.map((r) => (
            <circle key={r.label} cx={x} cy={L.yOf(r.ft)} r={3} fill={r.color} stroke="#fff" strokeWidth={1} />
          ))}
        </svg>
        {rows.length > 0 && (
          <div
            className={css.tooltip}
            style={flip ? { right: L.contentW - x + 10, top: L.plotTop } : { left: x + 10, top: L.plotTop }}
          >
            {rows.map((r) => (
              <div key={r.label} className={css.tooltipRow}>
                <span className={css.tooltipLabel} style={{ color: r.color }}>{r.label}</span>
                <span className={css.tooltipVal}>{formatAltitudeFt(r.ft)}</span>
              </div>
            ))}
          </div>
        )}
      </>
    )
  }

  return (
    <div
      ref={layerRef}
      className={css.hoverLayer}
      style={{ width: L.contentW, height: chartHeightOf(L) }}
    >
      {content}
    </div>
  )
})

/** Scrub distance from a scrolled chart edge (px) at which dragging scrolls the chart along. */
const SCRUB_EDGE_PX = 32
/** Chart scroll per animation frame while the aircraft is held at an edge (px). */
const SCRUB_SCROLL_STEP_PX = 10
/** A touch that moves less than this (px) and lifts quickly is a tap. */
const TAP_SLOP_PX = 8
const TAP_MAX_MS = 350

/**
 * Flight-log inspection: an aircraft on the flown line that can be moved along it.
 * Mouse: follows the pointer while it is over the chart. Touch: drag the aircraft
 * (scrolling the chart along at its edges), or tap a spot to move it there; elsewhere
 * a swipe still scrolls the chart. The aircraft stays where it was left, and the
 * readout (elapsed time, altitude, ground speed, height above ground, MSA) shows
 * while it is moved and after a touch, so it can be read without hovering.
 * Reports the inspected distance for the map marker from the first interaction on.
 */
const FlownScrubOverlay = memo(function FlownScrubOverlay({ layout: L, series, flown, bands, silhouette, onHoverDistNm, jumpTo }: {
  layout: ProfileChartLayout
  series: ProfileSeries
  flown: FlownPoint[]
  /** Airspace bands (terrain applied), for the "in airspace" rows of the readout. */
  bands: { class: string; type: string; name: string; tag: string; border: string; lower_ft: number; upper_ft: number; entryNm: number; exitNm: number }[]
  silhouette: ReturnType<typeof getAircraftSilhouette>
  onHoverDistNm?: (distNm: number | null) => void
  /** Move the aircraft to this point (an event picked in the list); `n` makes a repeat pick count. */
  jumpTo?: { index: number; n: number } | null
}) {
  const totalNm = flown.length > 0 ? flown[flown.length - 1].distNm : 0
  // Idle position: the middle of the flight, so the aircraft is visible and clear of the departure clutter.
  const [idx, setIdx] = useState(() => flownIndexAt(flown, totalNm / 2))
  const [showReadout, setShowReadout] = useState(false)
  const [dragging, setDragging] = useState(false)
  const touchedRef = useRef(false)
  const onHoverRef = useRef(onHoverDistNm)
  onHoverRef.current = onHoverDistNm

  // A different log starts over in the middle, untouched.
  useEffect(() => {
    setIdx(flownIndexAt(flown, totalNm / 2))
    setShowReadout(false)
    touchedRef.current = false
  }, [flown, totalNm])
  // An event picked in the list: the aircraft goes there, readout shown, chart scrolled to it.
  useEffect(() => {
    if (!jumpTo || !flown[jumpTo.index]) return
    touchedRef.current = true
    setIdx(jumpTo.index)
    setShowReadout(true)
    const wrap = layerRef.current?.parentElement?.parentElement
    if (wrap) {
      const x = L.xOf(flown[jumpTo.index].distNm)
      wrap.scrollTo({ left: Math.max(0, x - wrap.clientWidth / 2), behavior: 'smooth' })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo])
  // The map marker follows the inspected point once the user has touched it, and goes with the chart.
  useEffect(() => {
    if (touchedRef.current && flown[idx]) onHoverRef.current?.(flown[idx].distNm)
  }, [idx, flown])
  useEffect(() => () => onHoverRef.current?.(null), [])

  const layerRef = useRef<HTMLDivElement>(null)
  const hostOf = () => layerRef.current?.parentElement ?? null
  const indexAtClientX = useCallback((clientX: number): number | null => {
    const host = layerRef.current?.parentElement
    if (!host || flown.length === 0) return null
    const px = Math.max(L.plotLeft, Math.min(L.plotRight, clientX - host.getBoundingClientRect().left))
    return flownIndexAt(flown, L.nmAtX(px))
  }, [L, flown])
  const moveTo = useCallback((clientX: number) => {
    const i = indexAtClientX(clientX)
    if (i == null) return
    touchedRef.current = true
    setIdx(i)
  }, [indexAtClientX])

  // Mouse / pen: follow the pointer over the chart; touch: a tap moves the aircraft.
  useEffect(() => {
    const host = hostOf()
    if (!host) return
    let tap: { x: number; y: number; t: number; id: number } | null = null
    const move = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        if (tap && tap.id === e.pointerId && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP_PX) tap = null
        return
      }
      if (dragging) return
      const px = e.clientX - host.getBoundingClientRect().left
      if (px < L.plotLeft || px > L.plotRight) { setShowReadout(false); return }
      moveTo(e.clientX)
      setShowReadout(true)
    }
    const down = (e: PointerEvent) => { if (e.pointerType === 'touch') tap = { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId } }
    const up = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !tap || tap.id !== e.pointerId) return
      const isTap = e.timeStamp - tap.t <= TAP_MAX_MS && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) <= TAP_SLOP_PX
      tap = null
      if (isTap) { moveTo(e.clientX); setShowReadout(true) }
    }
    const leave = (e: PointerEvent) => { if (e.pointerType !== 'touch' && !dragging) setShowReadout(false) }
    host.addEventListener('pointermove', move)
    host.addEventListener('pointerdown', down)
    host.addEventListener('pointerup', up)
    host.addEventListener('pointerleave', leave)
    return () => {
      host.removeEventListener('pointermove', move)
      host.removeEventListener('pointerdown', down)
      host.removeEventListener('pointerup', up)
      host.removeEventListener('pointerleave', leave)
    }
  }, [L, moveTo, dragging])

  // Dragging the aircraft; held near a scrolled chart edge, the chart scrolls along.
  const lastXRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const stopEdgeScroll = () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); rafRef.current = null }
  useEffect(() => stopEdgeScroll, [])
  const edgeScroll = () => {
    const wrap = hostOf()?.parentElement
    if (!wrap) { rafRef.current = null; return }
    const r = wrap.getBoundingClientRect()
    const x = lastXRef.current
    const dir = x < r.left + SCRUB_EDGE_PX ? -1 : x > r.right - SCRUB_EDGE_PX ? 1 : 0
    const before = wrap.scrollLeft
    if (dir !== 0) wrap.scrollLeft = before + dir * SCRUB_SCROLL_STEP_PX
    if (dir === 0 || wrap.scrollLeft === before) { rafRef.current = null; return }
    moveTo(x)
    rafRef.current = requestAnimationFrame(edgeScroll)
  }
  const onHandleDown = (e: React.PointerEvent<SVGGElement>) => {
    e.preventDefault()
    e.stopPropagation()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* no capture */ }
    lastXRef.current = e.clientX
    setDragging(true)
    setShowReadout(true)
    moveTo(e.clientX)
  }
  const onHandleMove = (e: React.PointerEvent<SVGGElement>) => {
    if (!dragging) return
    lastXRef.current = e.clientX
    moveTo(e.clientX)
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(edgeScroll)
  }
  const onHandleUp = (e: React.PointerEvent<SVGGElement>) => {
    if (!dragging) return
    try { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* released */ }
    stopEdgeScroll()
    setDragging(false)
    // Touch has no hover: keep the readout up after letting go. A mouse hides it on leaving the chart.
    if (e.pointerType !== 'touch') setShowReadout(false)
  }

  const fp = flown[idx]
  let content: ReactNode = null
  if (fp) {
    const x = L.xOf(fp.distNm)
    const si = nearestSampleIndex(series.distNms, fp.distNm)
    const gnd = series.ground?.[si]
    const msa = series.msa?.[si] ?? 0
    const altKnown = Number.isFinite(fp.altFt)
    const alt = altKnown ? fp.altFt : flownAltitudeAt(flown, fp.distNm)
    const y = Number.isFinite(alt) ? L.yOf(Math.max(L.yMin, Math.min(L.yMax, alt))) : L.plotTop + 20
    const rows: { label: string; value: string; color?: string }[] = [
      { label: 'Time', value: formatElapsed(fp.elapsedMs) },
      { label: 'UTC', value: formatUtcTime(fp.ts) },
      { label: 'Alt', value: altKnown ? formatAltitudeFt(alt) : '\u2014', color: FLOWN_COLOR },
      { label: 'GS', value: Number.isFinite(fp.spdKts) ? `${Math.round(fp.spdKts)} kt` : '\u2014', color: FLOWN_SPEED_COLOR },
    ]
    if (altKnown && gnd != null) rows.push({ label: 'AGL', value: formatAltitudeFt(alt - gnd), color: GROUND_COLOR })
    if (msa > 0) rows.push({ label: 'MSA', value: formatAltitudeFt(msa), color: altKnown && alt < msa ? DANGER_TEXT : MSA_COLOR })
    for (const b of altKnown ? flownAirspaceAt(bands, fp.distNm, alt).slice(0, 2) : []) {
      rows.push({ label: b.class, value: b.name })
    }
    const flip = x > L.contentW - 180
    content = (
      <>
        <svg className={css.hoverSvg} width={L.contentW} height={chartHeightOf(L)}>
          {showReadout && <line x1={x} y1={L.plotTop} x2={x} y2={L.plotBottom} stroke={CHART_LINE} strokeWidth={1} />}
          <g
            className={css.scrubHandle}
            transform={`translate(${x},${y})`}
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
          >
            <title>Drag the aircraft along the flight log to inspect it</title>
            {/* Finger-sized grab target; a faint ring shows it can be picked up. */}
            <circle r={20} className={css.scrubTarget} />
            {silhouette.map((part, i) => <path key={i} d={part.d} fill={part.fill ?? 'white'} opacity={part.opacity} stroke="rgba(0,0,0,0.7)" strokeWidth={0.6} />)}
          </g>
        </svg>
        {showReadout && (
          <div
            className={css.tooltip}
            style={flip ? { right: L.contentW - x + 24, top: L.plotTop } : { left: x + 24, top: L.plotTop }}
          >
            {rows.map((r) => (
              <div key={r.label} className={css.tooltipRow}>
                <span className={css.tooltipLabel} style={r.color ? { color: r.color } : undefined}>{r.label}</span>
                <span className={css.tooltipVal}>{r.value}</span>
              </div>
            ))}
          </div>
        )}
      </>
    )
  }

  return (
    <div ref={layerRef} className={css.hoverLayer} style={{ width: L.contentW, height: chartHeightOf(L) }}>
      {content}
    </div>
  )
})


// ---------------------------------------------------------------------------
// Leg level drag: press on a leg in the profile and drag up/down to change its
// planned level (dragLevelFt rules: a quarter of the finger travel up, half
// down, 100 ft steps, below the lowest step clears the override). While
// dragging, the modelled climbs/descents are hidden and every leg shows as a
// flat line at its level; the dragged leg turns red when below its MSA.
// ---------------------------------------------------------------------------

/** Pictograms closer than this (px) collapse to dots, highest obstacle first. */
const OBSTACLE_MIN_GAP_PX = 14
const LANDMARK_MIN_GAP_PX = 18

type ObstacleMark = { key: string; kind: string; cx: number; cy: number; groundY: number; opacity: number; limiting: boolean; priority: number; full: boolean; estimated: boolean; label: string; labelPos?: PlacedLabel; leader?: boolean }
type PoiMark = { key: string; kind: string; subtype: string; towered: boolean; label: string; cx: number; cy: number; priority: number; labelPos?: PlacedLabel }
type LandmarkMark = { key: string; kind: string; cx: number; cy: number; tipY: number; groundY: number; full: boolean; estimated: boolean }

/** Half-height of a leg's drag target around its level line (px). */
const LEG_HIT_HALF_PX = 12

type LegDragState = { leg: number; startAlt: number; startY: number; cand: number | null; shown: number; moved: boolean }

function LegDragLayer({ layout: L, spans, legMsa, totalNm, fallbackAltFt, ceilingFt, legOverrides, plannedPts, previewPts, chipBoxes, onLegLevelChange, drag, setDrag }: {
  layout: ProfileChartLayout
  spans: LegSpan[]
  legMsa: number[]
  totalNm: number
  /** Level a leg falls back to when its override is cleared. */
  fallbackAltFt: number
  /** Highest level a drag may reach (service ceiling / chart top). */
  ceilingFt: number
  legOverrides: LegOverride[]
  /** The drawn (projected) planned path; a leg is grabbed where its line is drawn. */
  plannedPts: { distNm: number; altFt: number }[]
  /** The path the aircraft would fly if the drag were released now (climbs and descents included). */
  previewPts: { distNm: number; altFt: number }[] | null
  /** Airspace chips already on the chart: the below-MSA shortcut must not sit on one. */
  chipBoxes: BoxRect[]
  /** Undefined while route editing is locked: targets then only explain how to unlock. */
  onLegLevelChange?: (legIndex: number, altFt: number | null) => void
  drag: LegDragState | null
  setDrag: (d: LegDragState | null) => void
}) {
  const pxPerFt = (L.yOf(0) - L.yOf(10000)) / 10000
  // A leg planned above the chart top (the scale follows the path the aircraft
  // can actually fly) is drawn and grabbed at the top edge, never off-chart.
  const yClamped = (ft: number) => Math.min(L.plotBottom, Math.max(L.plotTop + 2, L.yOf(ft)))
  // Grab target of a leg: a thick invisible stroke along its drawn path (the
  // projected climbs and descents), or a flat line at its level when the path
  // has no samples inside the leg.
  const hitPath = (s: LegSpan, flatY: number): string => {
    const pts = plannedPts.filter((p) => p.distNm >= s.fromNm && p.distNm <= s.toNm)
    if (pts.length < 2) return `M${L.xOf(s.fromNm)},${flatY} L${L.xOf(s.toNm)},${flatY}`
    return 'M' + pts.map((p) => `${L.xOf(p.distNm).toFixed(1)},${yClamped(p.altFt).toFixed(1)}`).join(' L')
  }

  // The pressed target keeps pointer capture for the whole gesture, so it
  // stays mounted (and un-moved) while the flat preview lines are drawn.
  const begin = (e: React.PointerEvent<SVGElement>, i: number, s: LegSpan) => {
    if (!onLegLevelChange) return
    // Capture keeps the gesture tracking outside the thin target; a pointer
    // the browser no longer knows must not abort the drag.
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* no capture */ }
    e.preventDefault()
    // Start from the altitude DRAWN under the pointer, not the leg's requested
    // level: an unreachable level sits far above the drawn line and made the
    // line jump to the top.
    const svgTop = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect().top
    const startAlt = Math.min(s.altFt, altAtY(e.clientY - svgTop, L.yOf(0), pxPerFt))
    setDrag({ leg: i, startAlt, startY: e.clientY, cand: startAlt >= LEVEL_STEP_FT ? startAlt : null, shown: startAlt, moved: false })
  }
  const move = (e: React.PointerEvent<SVGElement>) => {
    if (!drag) return
    const dy = e.clientY - drag.startY
    // Never clamp below where the drag started.
    const shown = Math.min(dragShownFt(drag.startAlt, dy, pxPerFt), Math.max(ceilingFt, drag.startAlt))
    const cand = shown < LEVEL_STEP_FT ? null : shown
    const moved = drag.moved || Math.abs(dy) >= DRAG_MIN_MOVE_PX
    if (shown !== drag.shown || cand !== drag.cand || moved !== drag.moved) setDrag({ ...drag, shown, cand, moved })
  }
  const end = (e: React.PointerEvent<SVGElement>, commit: boolean) => {
    if (!drag || !onLegLevelChange) return
    try { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already released */ }
    const { leg, cand, moved } = drag
    setDrag(null)
    // A press without real movement is not an edit.
    if (!commit || !moved) return
    const level = spans[leg]?.altFt
    if (cand === null) { if (legOverrides[leg]?.altFt != null) onLegLevelChange(leg, null) }
    else if (cand !== level) onLegLevelChange(leg, cand)
  }

  return (
    <svg className={css.dragSvg} width={L.contentW} height={chartHeightOf(L)}>
      {drag && (
        <g pointerEvents="none">
          {/* Leg frame: a tint over the dragged leg, a divider at every turning point and a number on each leg,
              so it is clear where a leg begins and ends and which one is moving. */}
          {spans.map((s, i) => {
            const x1 = L.xOf(s.fromNm), x2 = L.xOf(s.toNm)
            const mine = drag.leg === i
            return (
              <g key={`frame-${i}`}>
                {mine && <rect x={x1} y={L.plotTop} width={Math.max(0, x2 - x1)} height={L.plotH} fill="rgba(255,255,255,0.12)" />}
                {i > 0 && <line x1={x1} x2={x1} y1={L.plotTop} y2={L.plotBottom} stroke="rgba(255,255,255,0.45)" strokeWidth={1} strokeDasharray="4 3" />}
                {x2 - x1 > 22 && (
                  <g>
                    <circle cx={(x1 + x2) / 2} cy={L.plotTop + 27} r={8} fill={mine ? '#fff' : 'rgba(0,0,0,0.55)'} stroke="#fff" strokeWidth={1} />
                    <text x={(x1 + x2) / 2} y={L.plotTop + 31} textAnchor="middle" fontSize={10} fontWeight={700} fill={mine ? '#111' : '#fff'}>{i + 1}</text>
                  </g>
                )}
              </g>
            )
          })}
          {/* Where the aircraft would actually fly if released now. */}
          {previewPts && previewPts.length > 1 && (
            <>
              <path d={'M' + previewPts.map((p) => `${L.xOf(p.distNm).toFixed(1)},${yClamped(p.altFt).toFixed(1)}`).join(' L')} fill="none" stroke="rgba(0,0,0,0.7)" strokeWidth={5} strokeLinejoin="round" />
              <path d={'M' + previewPts.map((p) => `${L.xOf(p.distNm).toFixed(1)},${yClamped(p.altFt).toFixed(1)}`).join(' L')} fill="none" stroke={PLAN_COLOR} strokeWidth={2.75} strokeLinejoin="round" />
              {spans.slice(1).map((s, i) => {
                const near = previewPts.reduce((b, p) => (Math.abs(p.distNm - s.fromNm) < Math.abs(b.distNm - s.fromNm) ? p : b), previewPts[0])
                return <circle key={`pv-turn-${i}`} cx={L.xOf(s.fromNm)} cy={yClamped(near.altFt)} r={3} fill="#2a1038" stroke="#fff" strokeWidth={1.5} />
              })}
            </>
          )}
          {/* Every leg's level, so the whole plan can be read while one leg moves. */}
          {spans.map((s, i) => {
            const x1 = L.xOf(s.fromNm), x2 = L.xOf(s.toNm)
            const mine = drag.leg === i
            const alt = mine ? drag.shown : s.altFt
            const y = yClamped(alt)
            const below = legBelowMsa(s, totalNm, alt, legMsa[i] ?? 0)
            const mid = (x1 + x2) / 2
            if (!mine && x2 - x1 < 46) return null
            return (
              <g key={`lvl-${i}`}>
                {mine && <line x1={x1} x2={x2} y1={y} y2={y} stroke={below ? DANGER_COLOR : '#fff'} strokeWidth={1.5} strokeDasharray="6 4" />}
                <text x={mid} y={y - 8 >= L.plotTop + 46 ? y - 8 : Math.max(y + 16, L.plotTop + 50)} textAnchor="middle" fontSize={mine ? 12 : 10} fontWeight={700}
                  fill={below ? DANGER_TEXT : CHART_TEXT} {...HALO}>
                  {mine && drag.cand == null ? `release = route level (${formatAltitudeFt(fallbackAltFt)})` : formatAltitudeFt(alt)}
                  {mine && below ? ` \u2014 below MSA ${formatAltitudeFt(legMsa[i])}` : ''}
                </text>
              </g>
            )
          })}
        </g>
      )}
      {spans.map((s, i) => {
        const x1 = L.xOf(s.fromNm), x2 = L.xOf(s.toNm)
        const y = yClamped(s.altFt)
        const below = legBelowMsa(s, totalNm, s.altFt, legMsa[i] ?? 0)
        return (
          <g key={`hit-${i}`}>
            <path
              className={css.legHit}
              style={onLegLevelChange ? undefined : { pointerEvents: 'none' }}
              d={hitPath(s, y)}
              strokeWidth={LEG_HIT_HALF_PX * 2}
              onPointerDown={(e) => begin(e, i, s)}
              onPointerMove={move}
              onPointerUp={(e) => end(e, true)}
              onPointerCancel={(e) => end(e, false)}
            >
              <title>Drag up or down to change this leg&apos;s level</title>
            </path>
            {onLegLevelChange && !drag && below && x2 - x1 > 80 && (() => {
              // Above the line, else below it, else (when both are taken by airspace chips) none; the leg can still be dragged.
              const cx = (x1 + x2) / 2
              const spot = [y - 30, y + 14].find((top) => top > L.plotTop && top + 16 < L.plotBottom
                && !chipBoxes.some((c) => cx - 40 < c.right && cx + 40 > c.left && top < c.bottom && top + 16 > c.top))
              if (spot == null) return null
              return (
                <g className={css.legChip} onClick={() => onLegLevelChange(i, legMsa[i])}>
                  <rect x={cx - 40} y={spot} width={80} height={16} rx={8} />
                  <text x={cx} y={spot + 11} textAnchor="middle" fontSize={10}>{'\u25b2'} MSA {formatAltitudeFt(legMsa[i])}</text>
                </g>
              )
            })()}
          </g>
        )
      })}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function VirtualRadar({
  waypoints, legOverrides, units = DEFAULT_UNITS, title, onHoverDistNm, aircraftProfile,
  currentDistNm, currentAltFt, currentSpeedKts, currentVSpeedFpm, trajectoryMode, crosshairDistNm,
  crossTrackNm, weatherStations, airspaceCeilingFt, onLegLevelChange, followAircraft, corridorBand = true,
  flown, onClose, jumpToTs,
}: Props) {
  const logMode = flown != null
  const [legDrag, setLegDrag] = useState<LegDragState | null>(null)
  const dragging = legDrag !== null
  // A route change or a lock mid-drag must not leave a stale preview behind.
  useEffect(() => { setLegDrag(null) }, [waypoints, onLegLevelChange == null])

  const chartWrapRef = useRef<HTMLDivElement | null>(null)
  const [wrapW, setWrapW] = useState(0)
  // Recoloured obstacle/landmark SVG markup, keyed by "kind" — same
  // pictograms the map uses (OBSTACLE_ICON_DEFS/LANDMARK_ICON_DEFS), loaded
  // once per kind actually present on this route and cached across renders
  // by loadColoredSvgMarkup itself (module-level cache, url|colour keyed).
  const [iconMarkup, setIconMarkup] = useState<Record<string, string>>({})
  const [airspaceGeo, setAirspaceGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [obstacleGeo, setObstacleGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [waterGeo,    setWaterGeo]    = useState<GeoJSON.FeatureCollection | null>(null)
  const [landmarkGeo, setLandmarkGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  // Aerodromes, reporting points and navaids along the route (own distances per kind).
  const [poiSets, setPoiSets] = useState<{ aerodromes: GeoJSON.FeatureCollection | null; reporting: GeoJSON.FeatureCollection | null; navaids: GeoJSON.FeatureCollection | null }>({ aerodromes: null, reporting: null, navaids: null })
  const [terrainPts, setTerrainPts] = useState<TerrainPoint[]>([])
  // Neither the elevation API nor the hillshade DEM could supply terrain:
  // no ground line, no MSA, AGL bands at raw height. Said on the chart.
  const [terrainFailed, setTerrainFailed] = useState(false)
  const [collapsed, setCollapsed]         = useState(false)
  // Chart height: set by the splitter on top of the bottom pane (MapView).
  const chartH = useChartH()
  // Zoom on the distance axis (1 = whole route fitted / minimum legible).
  const [zoom, setZoom]                   = useState(1)
  const [showWindAloft, setShowWindAloft] = usePersistedFlag('ovfr:vr:wind', true)
  // The MSA line (below-MSA stretches in red stay on either way).
  const [showMsa, setShowMsa] = usePersistedFlag('ovfr:vr:msa', true)
  // Obstacle labels (the short tip altitude / name beside each limiting obstacle); the symbols stay either way.
  const [showObstLabels, setShowObstLabels] = usePersistedFlag('ovfr:vr:obst', true)
  // Flight log: the ground-speed line (own scale; exact values are in the readout either way).
  const [showSpeed, setShowSpeed] = usePersistedFlag('ovfr:vr:gs', true)

  // Extract performance model from selected aircraft profile.
  // Only populated when all critical perf fields are non-zero.
  const perf = useMemo((): AircraftPerfModel | null => {
    if (!aircraftProfile) return null
    const { rocSlFpm, rocCeilingFpm, serviceCeilingFt, climbIas, descentFpm, descentIas } = aircraftProfile
    if (rocSlFpm <= 0 || climbIas <= 0 || descentFpm <= 0 || descentIas <= 0) return null
    return { rocSlFpm, rocCeilingFpm: rocCeilingFpm ?? 50, serviceCeilingFt: serviceCeilingFt || 15000, climbIas, descentFpm, descentIas }
  }, [aircraftProfile])

  // Category-shaped marker (fixed-wing/glider/helicopter/gyrocopter) instead
  // of always the same generic single-engine-airplane silhouette — see
  // @open-vfr/shared/aircraftSilhouette's header for why only these four
  // groups exist. Mirrors native's identical change to VerticalProfile.tsx.
  const silhouette = useMemo(
    () => getAircraftSilhouette(aircraftProfile?.category),
    [aircraftProfile?.category],
  )

  // Load GeoJSON (again when the selected countries change)
  const { key: countriesKey } = useActiveCountries()
  useEffect(() => {
    loadCountryGeojson('airspace')
      .then(setAirspaceGeo)
      .catch(() => { /* offline — no airspace bands */ })
    loadCountryGeojson('obstacles')
      .then(setObstacleGeo)
      .catch(() => { /* offline — no obstacle markers */ })
    loadCountryGeojson('water')
      .then(setWaterGeo)
      .catch(() => { /* offline / not yet generated — no water crossings */ })
    loadCountryGeojson('landmarks')
      .then(setLandmarkGeo)
      .catch(() => { /* offline — no landmark markers */ })
    const none = () => null
    Promise.all([
      loadCountryGeojson('aerodromes').catch(none),
      loadCountryGeojson('waypoints').catch(none),
      loadCountryGeojson('navaids').catch(none),
    ]).then(([aerodromes, reporting, navaids]) => setPoiSets({ aerodromes, reporting, navaids }))
  }, [countriesKey])

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
    // shifted, instead of blanking it until the new samples arrive.
    const last = lastTerrainRef.current
    const carried = followAircraft && last ? carryLookaheadTerrain(last.wps, last.pts, waypoints) : null
    setTerrainPts(carried ?? [])
    setTerrainFailed(false)
    // A flight log is sampled densely from the DEM (~0.5 NM, free per sample); the API stays
    // at 100 points if the DEM does not cover it.
    // Look-ahead asks again every few seconds: the hillshade DEM first, the
    // elevation API (shared budget) only where the DEM has no coverage.
    fetchTerrainProfileShared(waypoints, API_BASE_URL, controller.signal, getRemoteDem(), { preferLookup: !!followAircraft || logMode, denseLookup: logMode })
      .then((pts) => {
        lastTerrainRef.current = { wps: waypoints, pts }
        setTerrainPts(pts)
        setTerrainFailed(false)
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') {
          console.warn('Terrain fetch failed:', err)
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
  const [msaMargins] = useMsaMargins()
  const abeamNm = resolveMsaMargins(msaMargins).abeamNm
  const rawProfile = useMemo(() => {
    if (waypoints.length < 2 || !airspaceGeo || !obstacleGeo) return null
    return buildVirtualRadarProfile(
      waypoints,
      legOverrides,
      airspaceGeo,
      obstacleGeo,
      waterGeo ?? undefined,
      landmarkGeo ?? undefined,
      airspaceCeilingFt ?? Infinity,
      aircraftProfile?.cruiseAltFt || undefined,
      { obstacleNm: abeamNm },
    )
  }, [waypoints, legOverrides, airspaceGeo, obstacleGeo, waterGeo, landmarkGeo, airspaceCeilingFt, aircraftProfile?.cruiseAltFt, abeamNm])
  // AGL limits are published as heights: lift them onto the terrain along the
  // crossing once the terrain profile is in, so bands draw at their real altitude.
  const profile = useMemo(
    () => rawProfile && { ...rawProfile, airspaceBands: applyTerrainToBands(rawProfile.airspaceBands, terrainPts) },
    [rawProfile, terrainPts],
  )

  // Load (and cache) the recoloured SVG markup for every obstacle/landmark
  // kind actually present on this route — same pictograms as the main map
  // (OBSTACLE_ICON_DEFS/LANDMARK_ICON_DEFS), rendered inline via a nested
  // <svg> (valid SVG-in-SVG).
  useEffect(() => {
    if (!profile) return
    const wanted = new Set<string>()
    for (const obs of profile.obstacles) wanted.add(`obs:${obs.kind}`)
    for (const lmk of profile.landmarks) wanted.add(`lmk:${lmk.kind}`)
    let cancelled = false
    for (const key of wanted) {
      if (iconMarkup[key]) continue
      const [kindGroup, kind] = key.split(':')
      const def = kindGroup === 'obs'
        ? (OBSTACLE_ICON_DEFS[kind] ?? OBSTACLE_ICON_FALLBACK_DEF)
        : LANDMARK_ICON_DEFS[kind]
      if (!def) continue
      loadColoredSvgMarkup(def.url, def.color)
        .then((markup) => { if (!cancelled) setIconMarkup((prev) => ({ ...prev, [key]: markup })) })
        .catch(() => { /* non-fatal — falls back to a plain dot */ })
    }
    return () => { cancelled = true }
  }, [profile, iconMarkup])

  // MSA lookup at a given distNm — shared with native (getMsaLookup).
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

  // Trajectory tick distances (NM along route) — mirrors the map trajectory
  // line marks. computeTrajectoryTicks is the same shared function native
  // uses; web's trajectoryMode is named 'time'|'dist' (native: 'time'|'nm')
  // so it's translated to the shared function's timeMode boolean here.
  const trajectoryTicks = useMemo(() => computeTrajectoryTicks({
    currentDistNm, currentSpeedKts, timeMode: trajectoryMode === 'time',
    marks: [1, 3, 5], totalNm: profile?.totalNm ?? 0,
  }), [currentDistNm, currentSpeedKts, trajectoryMode, profile])

  const trajectoryTickLabels = trajectoryMode === 'time'
    ? ['1m', '3m', '5m']
    : ['1nm', '3nm', '5nm']

  // Climb/descent-aware trajectory line — same shared domain math as
  // native's VerticalProfile.
  // The line runs on to the destination when the far marks lie beyond it.
  const trajectoryEndTick = useMemo(() => computeTrajectoryEndTick({
    currentDistNm, currentSpeedKts, timeMode: trajectoryMode === 'time',
    marks: [1, 3, 5], totalNm: profile?.totalNm ?? 0,
  }), [currentDistNm, currentSpeedKts, trajectoryMode, profile])
  const vspeedTrajectory = useMemo(() => computeVspeedTrajectory({
    currentDistNm, currentAltFt, currentVSpeedFpm,
    ticks: trajectoryEndTick ? [...trajectoryTicks, trajectoryEndTick] : trajectoryTicks, getMsa,
  }), [currentDistNm, currentAltFt, currentVSpeedFpm, trajectoryTicks, trajectoryEndTick, getMsa])
  const vspeedAttitudeColor =
    vspeedTrajectory.attitude === 'climb'   ? 'rgba(34,197,94,0.85)'   :
    vspeedTrajectory.attitude === 'descent' ? 'rgba(248,113,113,0.85)' :
                                               'rgba(255,255,255,0.55)'

  // Weather stations projected onto the route's distance axis — same shared
  // projection native uses for its wind-arrow/cloud-layer overlay.
  // TAF only fills in wind/clouds when a station has no current METAR (see
  // resolveStationWeather / parseTaf.ts header for the full scope note —
  // this is NOT a route-position-vs-forecast-time overlay, that needs an
  // ETD field this app doesn't have).
  const weatherMarks = useMemo(() => {
    if (!weatherStations || !profile) return []
    return projectWeatherMarks(waypoints, weatherStations, profile.totalNm).map((m) => {
      const resolved = resolveStationWeather({
        metarWind: m.station.decoded?.wind ?? null,
        metarClouds: m.station.decoded?.clouds ?? null,
        taf: m.station.taf,
      })
      return { station: m.station, distNm: m.distNm, offRouteNm: m.offRouteNm, wind: resolved.wind, clouds: resolved.clouds }
    })
  }, [weatherStations, waypoints, profile])

  // Measure the chart wrap's width: it decides whether the route is wider
  // than the panel (MIN_PX_PER_UNIT) and therefore scrolls. Deps are not []:
  // the wrap div doesn't exist on the first commit (no profile yet) or while
  // collapsed, so the observer is re-attached whenever it can newly appear.
  useEffect(() => {
    const el = chartWrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w != null) setWrapW(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [collapsed, profile])

  // Flight log: aerodromes on the flown track (within 1.5 NM of it) plus the log's own start and end.
  const logFieldNms = useMemo(() => {
    if (!flown || flown.length === 0) return [] as number[]
    const fields = collectRoutePois(waypoints, poiSets).filter((p) => p.kind === 'aerodrome' && p.lateralNm <= 1.5).map((p) => p.distNm)
    return [0, flown[flown.length - 1].distNm, ...fields]
  }, [flown, waypoints, poiSets])

  // Per-sample series: terrain samples when terrain is in (planned altitude
  // projected onto them), else the planned altitude breakpoints alone.
  const series = useMemo((): ProfileSeries | null => {
    if (!profile) return null
    // Without a ground line but with a grid-made MSA the path and the MSA line are still sampled.
    const gridOnly = terrainPts.length === 0 && msaTerrain.fromGridOnly
    if (flown) {
      // Flight log: the flown altitude takes the plan's place. Sampled at the terrain samples
      // (readout, scale); the line itself and its below-MSA stretches use every recorded point.
      const base = terrainPts.length > 0 ? terrainPts : gridOnly ? msaTerrain.pts : null
      const distNms = base ? base.map((p) => p.distNm) : flown.map((p) => p.distNm)
      const alts = distNms.map((d) => { const a = flownAltitudeAt(flown, d); return Number.isFinite(a) ? a : 0 })
      const msaKnown = terrainPts.length > 0 || gridOnly
      const pts = flown.filter((p) => Number.isFinite(p.altFt))
      // No endpoint allowance: a log starts and ends on the ground. Being low near an aerodrome
      // on the track (or the log's own start and end) is shown softer instead of in red.
      const runs = msaKnown
        ? belowMsaRuns({ distNms: pts.map((p) => p.distNm), plannedAlts: pts.map((p) => p.altFt), getMsa, totalNm: profile.totalNm, suppressNm: 0 })
        : []
      const split = splitBelowMsaNearFields(runs, logFieldNms, FLOWN_NEAR_FIELD_NM)
      return {
        distNms,
        plannedAlts: alts,
        ground: terrainPts.length > 0 ? terrainPts.map((p) => p.elevFt) : null,
        msa: msaKnown ? distNms.map((d) => getMsa(d)) : null,
        belowMsa: split.away,
        belowMsaNearField: split.nearField,
      }
    }
    if (terrainPts.length > 0 || gridOnly) {
      const base = terrainPts.length > 0 ? terrainPts : msaTerrain.pts
      const distNms = base.map((p) => p.distNm)
      // Departure / arrival elevation from the first and last terrain sample,
      // so the planned path starts and ends on the ground rather than at 0 ft
      // (0 ft when only the grid is available: its cell maxima are not ground).
      const depElevFt = gridOnly ? 0 : (terrainPts[0]?.elevFt ?? 0)
      const arrElevFt = gridOnly ? 0 : (terrainPts[terrainPts.length - 1]?.elevFt ?? 0)
      // Climb/descent follow the aircraft's performance (generic model without one).
      const plannedAlts = projectFlightPath(profile.altitudeProfile, profile.totalNm, perf ?? DEFAULT_PERF_MODEL, distNms, depElevFt, arrElevFt)
      return {
        distNms,
        plannedAlts,
        ground: gridOnly ? null : terrainPts.map((p) => p.elevFt),
        msa: distNms.map((d) => getMsa(d)),
        belowMsa: belowMsaRuns({ distNms, plannedAlts, getMsa, totalNm: profile.totalNm }),
      }
    }
    return {
      distNms: profile.altitudeProfile.map((p) => p.distNm),
      plannedAlts: profile.altitudeProfile.map((p) => p.altFt),
      ground: null,
      msa: null,
      belowMsa: [],
    }
  }, [profile, terrainPts, msaTerrain, perf, getMsa, flown, logFieldNms])

  // While a leg level is dragged: the path the aircraft would fly at that level (climbs and descents
  // included), so the effect on the whole route is visible before the change is committed.
  const dragPreviewPts = useMemo(() => {
    if (!profile || !series || !legDrag?.moved) return null
    const gridOnly = terrainPts.length === 0 && msaTerrain.fromGridOnly
    if (terrainPts.length === 0 && !gridOnly) return null
    const dep = gridOnly ? 0 : (terrainPts[0]?.elevFt ?? 0)
    const arr = gridOnly ? 0 : (terrainPts[terrainPts.length - 1]?.elevFt ?? 0)
    const level = legDrag.cand ?? (aircraftProfile?.cruiseAltFt || 3500)
    const alts = projectFlightPath(withLegLevel(profile.altitudeProfile, legDrag.leg, level), profile.totalNm, perf ?? DEFAULT_PERF_MODEL, series.distNms, dep, arr)
    return series.distNms.map((d, i) => ({ distNm: d, altFt: alts[i] }))
  }, [profile, series, legDrag, terrainPts, msaTerrain, perf, aircraftProfile?.cruiseAltFt])

  // Flight log: the flown line in continuous stretches plus the recording gaps between them.
  const flownParts = useMemo(() => (flown ? flownLineParts(flown) : null), [flown])
  const flownSpeed = useMemo(() => (flown ? { scale: flownSpeedScale(flown), runs: flownSpeedRuns(flown) } : null), [flown])
  const flownGapInfo = useMemo(() => (flown ? flownGaps(flown) : null), [flown])
  const flownEntries = useMemo(() => (flown && profile ? flownAirspaceEntries(flown, profile.airspaceBands) : []), [flown, profile])
  // Opened from an event in the Logs list: inspect the recorded point at that time.
  const jumpTo = useMemo(() => {
    if (!flown || !jumpToTs || flown.length === 0) return null
    let best = 0
    for (let i = 1; i < flown.length; i++) if (Math.abs(flown[i].ts - jumpToTs.ts) < Math.abs(flown[best].ts - jumpToTs.ts)) best = i
    return { index: best, n: jumpToTs.n }
  }, [flown, jumpToTs])

  // Inputs of the drag layer, kept stable so a drag step only re-renders the layer, not rebuilds these.
  const plannedPts = useMemo(() => (series ? series.distNms.map((d, i) => ({ distNm: d, altFt: series.plannedAlts[i] })) : []), [series])

  // Leg spans and each leg's MSA, for the drag layer's targets and warnings.
  const legSpanList = useMemo(() => (profile ? legSpans(profile.altitudeProfile) : []), [profile])
  const legMsaFt = useMemo(() => legMsaList(legSpanList, msaPts, getMsa, legMsaFloors), [legSpanList, msaPts, getMsa, legMsaFloors])
  // Requested levels the drawn path never reaches (a short leg cannot climb that far): shown as a dashed marker instead of silently ignored.
  const phaseMarks = useMemo(
    () => (series ? verticalPhaseMarks(series.distNms.map((d, i) => ({ distNm: d, altFt: series.plannedAlts[i] }))) : []),
    [series],
  )
  const unreached = useMemo(
    () => (series ? unreachedLegs(legSpanList, series.distNms.map((d, i) => ({ distNm: d, altFt: series.plannedAlts[i] }))) : []),
    [legSpanList, series],
  )

  // The scale follows the path actually drawn (with climbs and descents the
  // aircraft's performance allows), not the requested levels: a short leg at
  // 7500 ft is never reached, and a 10000 ft axis over a 3400 ft line is noise.
  const plannedPeakFt = useMemo(() => {
    if (flown) return flown.reduce((m, p) => (Number.isFinite(p.altFt) ? Math.max(m, p.altFt) : m), 0)
    return series && series.plannedAlts.length > 0 ? Math.max(...series.plannedAlts) : (profile?.maxPlannedAltFt ?? 0)
  }, [series, profile, flown])
  const yMaxFull = useMemo(
    () => (profile ? profileYMax(plannedPeakFt, corridorPts.length > 0 ? corridorPts : terrainPts) : 10000),
    [profile, plannedPeakFt, corridorPts, terrainPts],
  )
  // Without a planned route (look-ahead while flying) the scale follows the aircraft's
  // altitude and vertical speed instead of a plan, so ground detail stays in view.
  const liveWindow = useMemo(
    () => (followAircraft && currentAltFt != null ? liveAltitudeWindow(currentAltFt, currentVSpeedFpm ?? 0) : null),
    [followAircraft, currentAltFt, currentVSpeedFpm],
  )
  const yMax = liveWindow ? liveWindow.yMax : yMaxFull

  // Bottom of the scale (profileYMin): 0 near the coast, raised over high ground.
  const yMin = useMemo(() => {
    if (liveWindow) return liveWindow.yMin
    if (!profile) return 0
    return profileYMin(terrainPts.map((p) => p.elevFt), series?.plannedAlts ?? [], yMax)
  }, [profile, terrainPts, series, yMax, liveWindow])

  // Winds aloft at the standard levels up to the chart top, one column every
  // ~20 NM, so the best level for the wind is visible at a glance. Model data
  // (Open-Meteo), nominal ISA height of each pressure level.
  // Not for a flight log: today's forecast says nothing about a past flight.
  const windOn = showWindAloft && !logMode
  const { columns: windAloft, status: windAloftStatus } = useWindAloftAlongRoute(waypoints, profile?.totalNm ?? 0, yMax, windOn)

  const unitPerNm = nmToDisplay(1, units.distance)
  const layout = useMemo(() => (profile && wrapW > 0
    ? profileChartLayout({
      viewportW: wrapW, height: chartH, margin: MARGIN,
      totalNm: profile.totalNm, yMax, yMin, minPxPerNm: MIN_PX_PER_UNIT * unitPerNm, zoom,
    })
    : null), [profile, wrapW, yMax, yMin, unitPerNm, chartH, zoom])

  // ── Zoom on the distance axis ────────────────────────────────────────────
  // Buttons, Ctrl/⌘ + wheel (also a trackpad pinch) and a two-finger pinch.
  // The route position under the cursor / fingers stays put; the scroll
  // offset is corrected right after the wider layout is committed.
  const layoutRef = useRef(layout); layoutRef.current = layout
  const zoomRef = useRef(zoom); zoomRef.current = zoom
  const pendingScrollRef = useRef<number | null>(null)
  // The zoom buttons only appear when there is room to zoom: a short route already sits near the maximum
  // scale, where they would change nothing.
  const canZoom = zoom > 1 || (layout != null && clampProfileZoom(1e9, layout.plotW / zoom, layout.totalNm) > 1.05)
  const zoomBy = useCallback((factor: number, anchorPx?: number) => {
    const el = chartWrapRef.current, L0 = layoutRef.current
    if (!el || !L0) return
    const base = L0.plotW / zoomRef.current
    const next = clampProfileZoom(zoomRef.current * factor, base, L0.totalNm)
    if (next === zoomRef.current) return
    const newPlotW = base * next
    pendingScrollRef.current = scrollAfterZoom({
      scrollLeft: el.scrollLeft, anchorPx: anchorPx ?? el.clientWidth / 2, plotLeft: L0.plotLeft,
      oldPlotW: L0.plotW, newPlotW, viewportW: el.clientWidth, newContentW: newPlotW + MARGIN.left + MARGIN.right,
    })
    zoomRef.current = next
    setZoom(next)
  }, [])
  useLayoutEffect(() => {
    const el = chartWrapRef.current
    if (el && pendingScrollRef.current != null) { el.scrollLeft = pendingScrollRef.current; pendingScrollRef.current = null }
  }, [layout])
  const hasChart = layout != null && !collapsed
  useEffect(() => {
    const el = chartWrapRef.current
    if (!el || !hasChart) return
    const anchorOf = (clientX: number) => clientX - el.getBoundingClientRect().left
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return   // plain wheel keeps scrolling the page / chart
      e.preventDefault()
      zoomBy(Math.exp(-e.deltaY * 0.01), anchorOf(e.clientX))
    }
    // Two-finger pinch (touch screens): pointer distance ratio between moves.
    const pts = new Map<number, { x: number; y: number }>()
    let lastDist = 0
    const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y) }
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pts.size === 2) lastDist = dist()
    }
    const onMove = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pts.size !== 2) return
      const d = dist()
      if (lastDist > 0 && d > 0) {
        const [a, b] = [...pts.values()]
        zoomBy(d / lastDist, anchorOf((a.x + b.x) / 2))
      }
      lastDist = d
    }
    const onUp = (e: PointerEvent) => { pts.delete(e.pointerId); lastDist = 0 }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onDown, true)
    el.addEventListener('pointermove', onMove, true)
    el.addEventListener('pointerup', onUp, true)
    el.addEventListener('pointercancel', onUp, true)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onDown, true)
      el.removeEventListener('pointermove', onMove, true)
      el.removeEventListener('pointerup', onUp, true)
      el.removeEventListener('pointercancel', onUp, true)
    }
  }, [hasChart, zoomBy])

  const yTicks = useMemo(() => altitudeTicksFrom(yMax, yMin), [yMax, yMin])
  // Distance ticks on round display-unit values; the right end of the axis is
  // left free for the unit label (see distanceTicks).
  const xTicks = useMemo(() => {
    if (!layout) return []
    const target = Math.max(2, Math.round(layout.plotW / X_TICK_SPACING_PX))
    // Keep ~30 px at the right end free for the unit label (a fraction of
    // the axis would leave tens of NM unlabelled on a long scrolling route).
    const reserve = Math.min(0.5, 30 / Math.max(1, layout.plotW))
    return distanceTicks(layout.totalNm * unitPerNm, target, reserve).map((v) => ({ label: v.toFixed(0), nm: v / unitPerNm }))
  }, [layout, unitPerNm])

  // ── Wind row (just under the x axis) ───────────────────────────────────────
  // METAR/TAF station barbs plus, with the WIND toggle on, the ground (10 m)
  // model barb of every winds-aloft column that has no station nearby. Each
  // barb keeps its route position and degrades: dir/kt text -> barb only ->
  // not drawn, whenever it would overlap a tick label, another barb or the
  // chart edge (see @open-vfr/shared/windRow).
  const windRow = useMemo(() => {
    if (!layout) return { barbs: [], tickLabelShown: [] as boolean[] }
    type RowWind = { dirDeg: number | null; speedKt: number; calm: boolean }
    const winds = new Map<string, { distNm: number; wind: RowWind; priority: number }>()
    for (const [i, m] of weatherMarks.entries()) {
      if (m.wind) winds.set(`st-${i}`, { distNm: m.distNm, wind: { dirDeg: m.wind.dirDeg ?? null, speedKt: m.wind.speedKt, calm: !!m.wind.calm }, priority: 0 })
    }
    if (windOn) {
      const stationNms = weatherMarks.filter((m) => m.wind).map((m) => m.distNm)
      for (const [ci, col] of windAloft.entries()) {
        const g = col.levels.find((l) => l.surface)
        if (!g || stationNms.some((d) => Math.abs(d - col.distNm) < WIND_ROW_STATION_SEP_NM)) continue
        winds.set(`gr-${ci}`, { distNm: col.distNm, wind: { dirDeg: g.dirDeg, speedKt: g.speedKts, calm: g.speedKts === 0 }, priority: 1 })
      }
    }
    const labelOf = (w: RowWind) => w.calm ? 'CALM' : w.dirDeg == null ? '' : `${String(w.dirDeg).padStart(3, '0')}\u00b0/${w.speedKt}`
    const minPx = layout.plotLeft + WIND_ROW_EDGE_L_PX
    const maxPx = layout.plotRight - WIND_ROW_EDGE_R_PX
    const items: WindRowItem[] = [...winds.entries()].map(([key, v]) => ({
      key, priority: v.priority,
      // Clamped into the margin: departure/destination stations sit exactly on
      // the plot edges, and a small nudge keeps the barb clear of the "0" tick
      // label (left) and the unit label (right).
      px: Math.min(Math.max(layout.xOf(v.distNm), minPx), maxPx),
      labelW: labelOf(v.wind).length * 10 * 0.62,
    }))
    // Barbs beat distance-tick labels (a tick lands every ~100 px, so the
    // other way round hides most of the row); colliding labels are hidden
    // instead. The "0" label never yields to a barb: the departure barb is
    // nudged clear of it by minPx anyway.
    const placed = layoutWindRow(items, {
      tickPx: [], minPx, maxPx, leftLimitPx: 4, rightLimitPx: layout.contentW,
    })
    const tickLabelShown = tickLabelsClearOfWindRow(xTicks.map((t) => layout.xOf(t.nm)), items, placed)
      .map((clear, i) => clear || xTicks[i].nm === 0)
    return {
      barbs: placed.map((pl) => ({ ...pl, wind: winds.get(pl.key)!.wind, text: labelOf(winds.get(pl.key)!.wind), model: pl.key.startsWith('gr-') })),
      tickLabelShown,
    }
  }, [layout, weatherMarks, windAloft, windOn, xTicks])

  // Waypoint-name label collision avoidance on the real label rectangles
  // (see @open-vfr/shared/profileLabels): names are variable-width and the
  // destination label is right-aligned to its line. The destination always
  // wins; the departure is skipped (it sits on the altitude axis).
  const visibleWaypointTicks = useMemo(() => {
    // A flight log's path vertices are simplification points, not waypoints.
    if (!profile || !layout || logMode) return []
    const ticks = profile.waypointTicks
    const lastIdx = ticks.length - 1
    const rects = ticks.map((t, i) => {
      const x = layout.xOf(t.distNm)
      const w = waypointLabelWidth(t.name)
      return i === lastIdx
        ? { left: x - LINE_LABEL_INSET - w, right: x - LINE_LABEL_INSET }
        : { left: x + LINE_LABEL_INSET, right: x + LINE_LABEL_INSET + w }
    })
    return pickWaypointLabels(rects, layout.plotLeft).map((i) => ({ tick: ticks[i], isLast: i === lastIdx }))
  }, [profile, layout, logMode])

  // Auto-follow the aircraft while flying, mirroring native: if its marker
  // has scrolled near/out of the visible window, re-center on it. Skipped
  // while a map-driven crosshair is active so it doesn't fight that.
  useEffect(() => {
    const el = chartWrapRef.current
    if (!el || !layout?.scrollable || currentDistNm == null || crosshairDistNm != null) return
    const markerX = layout.xOf(currentDistNm)
    const EDGE = 40
    if (markerX < el.scrollLeft + EDGE || markerX > el.scrollLeft + wrapW - EDGE) {
      el.scrollTo({ left: Math.max(0, Math.min(layout.contentW - wrapW, markerX - wrapW / 2)), behavior: 'smooth' })
    }
  }, [currentDistNm, layout, wrapW, crosshairDistNm])

  // Terrain gradient: elevation bands in chart space (yMax at the top of the
  // plot, 0 ft at the bottom) so a colour always means the same altitude.
  // blue sea level → green lowland → brown hills → grey mountains
  const terrainStops = useMemo(
    () => terrainGradientStops(yMin, yMax).map((st) => ({ offset: `${st.offset.toFixed(1)}%`, color: st.color })),
    [yMax, yMin],
  )

  // ── Static scene ───────────────────────────────────────────────────────────
  // Everything that only changes with the route, terrain, weather or panel
  // size. Memoised so the per-GPS-tick re-render (live layer below) only
  // rebuilds the aircraft marker and trajectory, not airspace, clouds, icons.
  // Obstacle and landmark symbols. Obstacles are collected out to the abeam
  // distance the MSA uses and fade with distance off track; the one that sets
  // the MSA is named in red; a crowd collapses to dots (highest first keeps its
  // pictogram). Landmarks thin out the same way, lower priority.
  // Airspace chip boxes for the leg-drag layer (its below-MSA shortcut keeps clear of them).
  const chipBoxes = useMemo((): BoxRect[] => (profile && layout
    ? layoutAirspaceChips(airspaceChips(profile.airspaceBands, yMax), layout.xOf, layout.yOf).map((c) => ({ left: c.px, right: c.px + c.w, top: c.py, bottom: c.py + c.h }))
    : []), [profile, layout, yMax])
  const { obstacleMarks, landmarkMarks, poiMarks } = useMemo(() => {
    const none = { obstacleMarks: [] as ObstacleMark[], landmarkMarks: [] as LandmarkMark[], poiMarks: [] as PoiMark[] }
    if (!profile || !layout) return none
    const L = layout
    const margins = resolveMsaMargins(msaMargins)
    // Symbols at the very start/end of the route are kept fully inside the plot
    // instead of being half cut off at its edge.
    const clampX = (x: number, half: number) => Math.max(L.xOf(0) + half, Math.min(L.xOf(L.totalNm) - half, x))
    const obs = profile.obstacles.map((o, i) => {
      const baseFt = Math.max(o.elevationFt, terrainAt(terrainPts, o.distNm))
      // Unknown height: the per-kind estimate (dashed on the chart, and the same
      // figure the MSA uses, see obstacleHeights.ts).
      const eh = effectiveHeight(o.kind, o.heightM)
      const tipFt = Math.round(baseFt + eh.heightM * FT_PER_M)
      const limiting = isLimitingObstacle(tipFt, margins.obstacleClearanceFt, getMsa(o.distNm))
      return {
        key: `obs-${i}`, kind: o.kind, cx: clampX(L.xOf(o.distNm), 8), cy: L.yOf(tipFt), groundY: L.yOf(Math.max(0, baseFt)),
        opacity: obstacleOpacity(o.lateralNm, margins.abeamNm) * (eh.estimated ? 0.85 : 1), limiting,
        priority: limiting ? 1e9 + tipFt : tipFt, full: false, estimated: eh.estimated,
        label: limiting && showObstLabels ? limitingObstacleLabel(o.kind, o.name, tipFt, eh.estimated) : '', labelPos: undefined as PlacedLabel | undefined, leader: false,
      }
    })
    mergeNearbyLabels(obs, LIMITING_LABEL_MERGE_PX)
    const obsFull = declutterMarks(obs.map((m) => ({ id: m.key, x: m.cx, priority: m.priority })), OBSTACLE_MIN_GAP_PX)
    obs.forEach((m) => { m.full = obsFull.has(m.key) })
    const lmk = profile.landmarks.map((l, i) => {
      // Floored at 0: landmarks have no elevation of their own and
      // terrainAt() can go slightly negative from DEM noise near water.
      const baseFt = Math.max(0, terrainAt(terrainPts, l.distNm))
      const eh = effectiveHeight(l.kind, l.heightM)
      return {
        key: `lmk-${i}`, kind: l.kind, cx: clampX(L.xOf(l.distNm), 7), cy: L.yOf(baseFt),
        // Where the structure ends (its tip), for the full-height shape.
        tipY: L.yOf(Math.round(baseFt + eh.heightM * FT_PER_M)), groundY: L.yOf(baseFt), full: false, estimated: eh.estimated,
      }
    })
    const lmkFull = declutterMarks(lmk.map((m) => ({ id: m.key, x: m.cx, priority: 0 })), LANDMARK_MIN_GAP_PX)
    lmk.forEach((m) => { m.full = lmkFull.has(m.key) })
    // Aerodromes / reporting points / navaids: symbols always drawn, labels
    // thinned by priority (aerodromes first, towered before others).
    const pois = collectRoutePois(waypoints, poiSets).map((p, i) => {
      const baseFt = poiBaseFt(p, terrainAt(terrainPts, p.distNm))
      return {
        key: `poi-${i}`, kind: p.kind, subtype: p.subtype, towered: p.towered, label: p.label,
        // Stands on the ground line (like the obstacles) instead of being centred on it, where the
        // ground fill would cover its lower half and the axis would cut it off.
        cx: clampX(L.xOf(p.distNm), 6), cy: poiCenterY(L.yOf(baseFt), L.plotBottom),
        priority: p.kind === 'aerodrome' ? (p.towered ? 4 : 3) : p.kind === 'navaid' ? 2 : 1, labelPos: undefined as PlacedLabel | undefined,
      }
    })
    // Names (the obstacle that sets the MSA, aerodromes, navaids, reporting
    // points) are placed by rectangle: each tries above / below / beside its
    // symbol and takes the first spot clear of every symbol and other label.
    const sym = (cx: number, top: number, bottom: number, half: number): BoxRect => ({ left: cx - half, right: cx + half, top, bottom })
    const obsBox = (m: (typeof obs)[number]) => !m.full ? sym(m.cx, m.cy - 3, m.cy + 3, 3)
      : symbolGroundY(m.cy, m.groundY, L.plotBottom) - m.cy >= MIN_FULL_HEIGHT_PX ? sym(m.cx, m.cy, symbolGroundY(m.cy, m.groundY, L.plotBottom), 11) : sym(m.cx, m.cy - 16, Math.max(m.cy, m.groundY), 8)
    const chipBoxes: BoxRect[] = [
      ...layoutAirspaceChips(airspaceChips(profile.airspaceBands, yMax), L.xOf, L.yOf)
        .map((c): BoxRect => ({ left: c.px, right: c.px + c.w, top: c.py, bottom: c.py + c.h })),
    ]
    const cloudBoxes: BoxRect[] = [
      // Cloud glyph strips: names must not sit on the clouds.
      ...weatherMarks.flatMap((m) => {
        const hw = cloudStripHalfWidthNm(L.totalNm)
        return m.clouds.map((c): BoxRect => {
          const yb = L.yOf(c.baseFt)
          return { left: L.xOf(Math.max(0, m.distNm - hw)), right: L.xOf(Math.min(L.totalNm, m.distNm + hw)), top: yb - cloudGlyphHeight(c), bottom: yb }
        })
      }),
    ]
    const avoid: BoxRect[] = [
      ...obs.map(obsBox),
      ...lmk.map((m) => !m.full ? sym(m.cx, m.cy - 2, m.cy + 2, 2)
        : m.groundY - m.tipY >= MIN_FULL_HEIGHT_PX ? sym(m.cx, m.tipY, m.groundY, 11) : sym(m.cx, m.cy - 14, m.cy, 7)),
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
    // Names keep clear of symbols, airspace chips and clouds when there is room; a limiting
    // obstacle's name is never dropped (lifted with a leader line, or fewer constraints).
    const { placed, leaders } = placeRadarLabels({
      requests, symbols: avoid, chips: chipBoxes, clouds: cloudBoxes, mustShow: (id) => id.startsWith('obs-'),
      area: { left: L.plotLeft, right: L.plotRight, top: L.plotTop + 14, bottom: L.plotBottom - 2 },
    })
    obs.forEach((m) => { m.leader = leaders.has(m.key) })
    obs.forEach((m) => { m.labelPos = placed.get(m.key) })
    pois.forEach((m) => { m.labelPos = placed.get(m.key) })
    return { obstacleMarks: obs, landmarkMarks: lmk, poiMarks: pois }
  }, [profile, layout, terrainPts, getMsa, msaMargins, waypoints, poiSets, yMax, yMin, weatherMarks, showObstLabels])

  const scene = useMemo(() => {
    if (!profile || !layout || !series) return null
    const L = layout
    const placedChips = layoutAirspaceChips(airspaceChips(profile.airspaceBands, yMax), L.xOf, L.yOf)
    // TOC / TOD labels: placed clear of chips, obstacle / aerodrome names and each other
    // (right of the dot first, then above, below, left).
    const phaseTaken: BoxRect[] = [
      ...placedChips.map((c): BoxRect => ({ left: c.px, right: c.px + c.w, top: c.py, bottom: c.py + c.h })),
      ...obstacleMarks.filter((m) => m.labelPos).map((m): BoxRect => {
        const w = obstacleLabelWidth(m.label)
        return { left: m.labelPos!.left, right: m.labelPos!.left + w, top: m.labelPos!.baseline - 13, bottom: m.labelPos!.baseline + 3 }
      }),
      ...poiMarks.filter((m) => m.labelPos).map((m): BoxRect => {
        const w = poiLabelWidth(m.label)
        return { left: m.labelPos!.left, right: m.labelPos!.left + w, top: m.labelPos!.baseline - 12, bottom: m.labelPos!.baseline + 3 }
      }),
    ]
    const phaseShown = phaseMarks.filter((m) => m.altFt <= yMax && m.altFt >= yMin).map((m) => {
      const short = m.kind === 'TOC' ? unreached.find((u) => { const sp = legSpanList[u.legIndex]; return sp && m.distNm >= sp.fromNm - 0.01 && m.distNm <= sp.toNm + 0.01 }) : undefined
      const text = phaseLabelText(m.kind, m.altFt, short?.levelFt)
      return { m, short, text, x: L.xOf(m.distNm), y: L.yOf(m.altFt), w: Math.ceil(text.length * 6.3) + 4 }
    })
    phaseShown.forEach((p) => phaseTaken.push({ left: p.x - 4, right: p.x + 4, top: p.y - 4, bottom: p.y + 4 }))
    const phasePlaced = new Map<number, PlacedLabel>()
    phaseShown.forEach((p, k) => {
      const got = placeLabels([{ id: String(k), x: p.x, top: p.y - 4, bottom: p.y + 4, halfW: 6, w: p.w, h: 14, priority: 1 }], phaseTaken,
        { left: L.plotLeft, right: L.plotRight, top: L.plotTop + 14, bottom: L.plotBottom - 2 }).get(String(k))
      if (got) { phasePlaced.set(k, got); phaseTaken.push({ left: got.left, right: got.left + p.w, top: got.baseline - 12, bottom: got.baseline + 2 }) }
    })
    const chipBoxes: BoxRect[] = placedChips.map((c) => ({ left: c.px, right: c.px + c.w, top: c.py, bottom: c.py + c.h }))
    const msaPath = series.msa
      ? polylinePath(series.distNms.flatMap((d, i) => (series.msa![i] > 0 ? [{ distNm: d, altFt: series.msa![i] }] : [])), L.xOf, L.yOf)
      : ''
    // While a leg level is being dragged the modelled climbs/descents are
    // hidden; the drag layer shows each leg as a flat line instead.
    const plannedPath = polylinePath(series.distNms.map((d, i) => ({ distNm: d, altFt: series.plannedAlts[i] })), L.xOf, L.yOf)
    const groundOutline = series.ground
      ? polylinePath(series.distNms.map((d, i) => ({ distNm: d, altFt: series.ground![i] })), L.xOf, L.yOf)
      : ''

    return (
      <>
        <defs>
          <linearGradient id="terrainGrad" gradientUnits="userSpaceOnUse" x1="0" y1={L.plotTop} x2="0" y2={L.plotBottom}>
            {terrainStops.map((s, i) => (
              <stop key={i} offset={s.offset} stopColor={s.color} />
            ))}
          </linearGradient>
          <linearGradient id="skyGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={SKY_TOP} />
            <stop offset="100%" stopColor={SKY_BOTTOM} />
          </linearGradient>
          <linearGradient id="cloudGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={CLOUD_COLORS.fillTop}    stopOpacity={CLOUD_COLORS.fillTopOpacity} />
            <stop offset="100%" stopColor={CLOUD_COLORS.fillBottom} stopOpacity={CLOUD_COLORS.fillBottomOpacity} />
          </linearGradient>
          <linearGradient id="cloudGradConvective" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={CLOUD_COLORS.convectiveFillTop}    stopOpacity={CLOUD_COLORS.fillTopOpacity} />
            <stop offset="100%" stopColor={CLOUD_COLORS.convectiveFillBottom} stopOpacity={CLOUD_COLORS.fillBottomOpacity} />
          </linearGradient>
        </defs>

        {/* ── Sky: mid-tone gradient so dark and light symbols both stand out ── */}
        <rect x={L.plotLeft} y={L.plotTop} width={L.plotW} height={L.plotH} fill="url(#skyGrad)" />

        {/* ── Grid ──────────────────────────────────────────────── */}
        <g stroke="rgba(255,255,255,0.22)" strokeDasharray="3 3">
          {yTicks.filter((ft) => ft % 1000 === 0 || ft === yMin).map((ft) => <line key={`yg-${ft}`} x1={L.plotLeft} y1={L.yOf(ft)} x2={L.plotRight} y2={L.yOf(ft)} />)}
          {xTicks.map((t) => <line key={`xg-${t.label}`} x1={L.xOf(t.nm)} y1={L.plotTop} x2={L.xOf(t.nm)} y2={L.plotBottom} />)}
        </g>

        {/* ── Airspace bands + chips ────────────────────────────── */}
        {renderAirspace(profile.airspaceBands, L)}

        {renderClouds(weatherMarks, placedChips, L, [...obstacleMarks, ...poiMarks].filter((m) => m.labelPos && m.label).map((m) => {
          const w = obstacleLabelWidth(m.label)
          return { x: m.labelPos!.left, y: m.labelPos!.baseline - 13, w, h: 16 }
        }))}

        {/* ── Ground fill (elevation-banded gradient) + outline ───
            Before water / obstacles / landmarks / POIs: the corridor band is
            translucent and the terrain fill opaque, so anything standing on
            the ground line must paint after them or it gets washed out. */}
        {series.ground && (
          <>
            {corridorBand && corridorPts.length > 0 && (
              <path d={groundAreaPath(corridorPts, L.xOf, L.yOf, L.totalNm)} fill={CORRIDOR_FILL} stroke={CORRIDOR_OUTLINE} strokeWidth={CORRIDOR_OUTLINE_WIDTH} />
            )}
            <path d={groundAreaPath(terrainPts, L.xOf, L.yOf, L.totalNm)} fill="url(#terrainGrad)" />
            <path d={groundOutline} fill="none" stroke={GROUND_OUTLINE} strokeWidth={1.5} />
          </>
        )}

        {/* ── Water (lake/reservoir) crossings ──────────────────── */}
        {/* Thin blue band along the ground baseline wherever the route
            crosses a lake/reservoir — marks that the terrain reading there
            is the water SURFACE, not solid ground. */}
        {profile.waterCrossings.map((wc, i) => {
          const spanElevs = terrainPts
            .filter((p) => p.distNm >= wc.entryNm && p.distNm <= wc.exitNm)
            .map((p) => p.elevFt)
          // Null when the water is below the scale floor (live altitude window).
          const topFt = waterBandTopFt(spanElevs, yMin, yMax)
          const x1 = L.xOf(wc.entryNm), x2 = L.xOf(wc.exitNm)
          // A zero-width crossing (route touching a shoreline) would draw as a
          // stray vertical stroke.
          if (topFt == null || x2 - x1 <= 0) return null
          const yTop = L.yOf(topFt)
          return (
            <rect key={`water-${i}`} x={x1} y={yTop} width={x2 - x1} height={L.plotBottom - yTop}
              fill="rgba(30,100,200,0.35)" stroke="rgba(60,140,230,0.7)" strokeWidth={1} />
          )
        })}

        {/* ── Obstacles at tip elevation, real map pictograms ───── */}
        {obstacleMarks.map((m) => {
          if (!m.full) {
            // Crowded: a dot at the tip, so nothing vanishes but a field of masts
            // does not turn into overlapping pictograms.
            return <circle key={m.key} cx={m.cx} cy={m.cy} r={2} fill="rgba(220,80,60,0.9)" opacity={m.opacity} />
          }
          // Tall enough: the real shape from the ground up to the tip altitude.
          const shape = obstacleSymbol(m.kind, m.cx, m.cy, symbolGroundY(m.cy, m.groundY, L.plotBottom), m.estimated)
          if (shape) {
            return (
              <g key={m.key} opacity={m.opacity}>
                <g transform={`translate(${m.cx} 0) scale(${obstacleXScale(m.kind)} 1) translate(${-m.cx} 0)`}>{renderShape(shape)}</g>
              </g>
            )
          }
          return (
            <g key={m.key} opacity={m.opacity}>
              {m.groundY - m.cy > 4 && (
                <>
                  <line x1={m.cx} y1={m.cy} x2={m.cx} y2={m.groundY} stroke="rgba(220,80,60,0.85)" strokeWidth={1.5} />
                  <circle cx={m.cx} cy={m.groundY} r={2} fill="rgba(220,80,60,0.95)" />
                </>
              )}
              {renderIconAt(`${m.key}-i`, m.cx, m.cy, 16, iconMarkup[`obs:${m.kind}`],
                <circle cx={m.cx} cy={m.cy} r={3} fill="rgba(220,80,60,0.85)" stroke="rgba(0,0,0,0.4)" strokeWidth={1} />)}
            </g>
          )
        })}

        {/* ── Wind row under the x axis (see windRow above) ─────── */}
        {windRow.barbs.map((w) => {
          const cx = w.px, cy = L.plotBottom + WIND_ROW_Y
          if (w.wind.dirDeg == null && !w.wind.calm) {
            return <circle key={`windrow-${w.key}`} cx={cx} cy={cy} r={3} fill="none" stroke="rgba(250,204,21,0.7)" strokeWidth={1} strokeDasharray="1.5,1.5" />
          }
          const color = w.wind.calm ? 'rgba(203,213,225,0.95)' : windBarbColorForSpeed(w.wind.speedKt)
          const ty = cy + 10 * 0.35
          return (
            <g key={`windrow-${w.key}`} aria-hidden="true" opacity={w.model ? 0.85 : 1}>
              {renderBarbAt(cx, cy, w.wind.dirDeg ?? 0, w.wind.speedKt, w.wind.calm)}
              {w.label === 'right' && <text x={cx + 13} y={ty} fontSize={11} fill={color} {...HALO}>{w.text}</text>}
              {w.label === 'left' && <text x={cx - 13} y={ty} fontSize={11} textAnchor="end" fill={color} {...HALO}>{w.text}</text>}
            </g>
          )
        })}

        {/* ── Winds aloft: barbs at each standard pressure level's nominal
            altitude, one column every ~20 NM (useWindAloftAlongRoute). Model
            forecast, so drawn dimmer than the station barbs. */}
        {windOn && windAloft.flatMap((col, ci) => col.levels.map((lv) => {
          // Surface (10 m) wind is part of the wind row under the x axis.
          if (lv.surface || lv.altFt > yMax * 0.96 || lv.altFt < yMin) return null
          const edge = Math.min(WIND_ALOFT_EDGE_PX, L.plotW / 2)
          const cx = Math.min(Math.max(L.xOf(col.distNm), L.plotLeft + edge), L.plotRight - edge)
          const cy = L.yOf(lv.altFt)
          const label = lv.speedKts === 0 ? 'CALM' : `${String(lv.dirDeg).padStart(3, '0')}°/${lv.speedKts}`
          // Keep clear of the airspace chips: label right, else left, else barb only.
          const fit = windAloftFit(cx, cy, Math.ceil(label.length * 6.8), chipBoxes, { left: L.plotLeft, right: L.plotRight })
          if (!fit.barb) return null
          return (
            <g key={`windaloft-${ci}-${lv.altFt}`} aria-hidden="true">
              {renderBarbAt(cx, cy, lv.dirDeg, lv.speedKts, lv.speedKts === 0)}
              {fit.label === 'right' && <text x={cx + 12} y={cy + 4} fontSize={11} fontWeight={600} fill={WIND_LABEL_COLOR} {...HALO}>{label}</text>}
              {fit.label === 'left' && <text x={cx - 12} y={cy + 4} fontSize={11} fontWeight={600} textAnchor="end" fill={WIND_LABEL_COLOR} {...HALO}>{label}</text>}
            </g>
          )
        }))}

        {/* ── Landmarks on the ground, real map pictograms ──────── */}
        {landmarkMarks.map((m) => {
          const shape = obstacleSymbol(LANDMARK_SHAPE_KIND[m.kind] ?? 'tower', m.cx, m.tipY, m.groundY, m.estimated)
          if (shape) return <g key={m.key} opacity={m.estimated ? 0.85 : 1}>{renderShape(shape)}</g>
          return m.full
          ? renderIconAt(m.key, m.cx, m.cy, 14, iconMarkup[`lmk:${m.kind}`],
            <circle cx={m.cx} cy={m.cy} r={2.5} fill="rgba(150,150,150,0.9)" stroke="rgba(0,0,0,0.4)" strokeWidth={1} />)
          : <circle key={m.key} cx={m.cx} cy={m.cy} r={1.6} fill="rgba(150,150,150,0.8)" />
        })}

        {/* ── Aerodromes, reporting points, navaids (own distance per kind) ── */}
        {poiMarks.map((m) => (
          <g key={m.key} aria-hidden="true" transform={`translate(${m.cx} ${m.cy}) scale(${POI_SCALE}) translate(${-m.cx} ${-m.cy})`}>
            {/* dark halo pass under the coloured symbol, so it holds up on any sky or ground */}
            {renderPoiSymbol(m, true)}
            {renderPoiSymbol(m, false)}
          </g>
        ))}

        {/* ── Waypoint lines + names (collision-filtered above) ─── */}
        {visibleWaypointTicks.map(({ tick, isLast }) => {
          const x = L.xOf(tick.distNm)
          return (
            <g key={`wp-${tick.distNm}-${tick.name}`}>
              <line x1={x} y1={L.plotTop} x2={x} y2={L.plotBottom} stroke={CHART_LINE} />
              <text
                x={isLast ? x - LINE_LABEL_INSET : x + LINE_LABEL_INSET} y={L.plotTop + LINE_LABEL_INSET}
                dominantBaseline="hanging" textAnchor={isLast ? 'end' : 'start'}
                fontSize={12} fontWeight={600} fill={CHART_TEXT}
              >
                {tick.name}
              </text>
            </g>
          )
        })}

        {/* ── Planned altitude line, MSA, below-MSA stretches in red ── */}
        <clipPath id="plan-clip"><rect x={L.plotLeft} y={L.plotTop} width={L.plotW} height={L.plotH + 4} /></clipPath>
        {/* Ground speed on its own scale (0 at the plot bottom, the GS button's range at the top), under the altitude line. */}
        {flownSpeed && showSpeed && (() => {
          const top = flownSpeed.scale.topKts
          const ys = (k: number) => L.plotBottom - (k / top) * L.plotH
          return (
            <g clipPath="url(#plan-clip)" pointerEvents="none">
              {flownSpeed.runs.map((run, i) => (
                <path key={`spd-${i}`} d={'M' + run.map((p) => `${L.xOf(p.distNm).toFixed(1)},${ys(p.spdKts).toFixed(1)}`).join(' L')}
                  fill="none" stroke={FLOWN_SPEED_COLOR} strokeWidth={1.5} strokeDasharray="5 3" opacity={0.85} />
              ))}
            </g>
          )
        })()}
        {flownParts && (
          <g clipPath="url(#plan-clip)" pointerEvents="none">
            {flownParts.runs.map((run, i) => {
              const d = polylinePath(run, L.xOf, L.yOf)
              return (
                <g key={`flown-${i}`}>
                  <path d={d} fill="none" stroke="rgba(0,0,0,0.7)" strokeWidth={5} strokeLinejoin="round" />
                  <path d={d} fill="none" stroke={FLOWN_COLOR} strokeWidth={2.75} strokeLinejoin="round" />
                </g>
              )
            })}
          </g>
        )}
        {!logMode && (<>
        <path d={plannedPath} clipPath="url(#plan-clip)" fill="none" stroke="rgba(0,0,0,0.7)" strokeWidth={5} strokeLinejoin="round" opacity={dragging ? 0.18 : 1} />
        <path d={plannedPath} clipPath="url(#plan-clip)" fill="none" stroke={PLAN_COLOR} strokeWidth={2.75} strokeLinejoin="round" opacity={dragging ? 0.18 : 1} />
        {/* Turn points: white dots with a dark rim where one leg ends and the next begins. */}
        {!dragging && legSpanList.slice(1).map((sp, i) => {
          const alt = series.plannedAlts[nearestSampleIndex(series.distNms, sp.fromNm)]
          if (alt == null || alt > yMax) return null
          if (phaseMarks.some((m) => Math.abs(m.distNm - sp.fromNm) < 0.3 && Math.abs(m.altFt - alt) < 150)) return null
          return <circle key={`turn-${i}`} cx={L.xOf(sp.fromNm)} cy={L.yOf(alt)} r={2.75} fill="#2a1038" stroke="#fff" strokeWidth={1.5} />
        })}
        {unreached.map((u) => {
          const sp = legSpanList[u.legIndex]
          if (!sp) return null
          // A level above the chart top is pinned to the top edge, labelled with its value, so it is never silently absent.
          const above = u.levelFt > yMax
          const y = Math.max(L.plotTop + 2, L.yOf(u.levelFt))
          const x1 = L.xOf(sp.fromNm), x2 = L.xOf(sp.toNm)
          return (
            <g key={`unreached-${u.legIndex}`} pointerEvents="none">
              <line x1={x1} x2={x2} y1={y} y2={y} stroke={PLAN_COLOR} strokeWidth={1.5} strokeDasharray="6 4" opacity={0.75} />
              {above && !dragging && x2 - x1 > 70 && (
                <text x={(x1 + x2) / 2} y={L.plotTop + 46} textAnchor="middle" fontSize={10} fontWeight={700} fill={CHART_TEXT} {...HALO}>
                  {'\u25b2'} {formatAltitudeFt(u.levelFt)} set
                </text>
              )}
            </g>
          )
        })}
        {/* Top of climb / top of descent on the flown path. A climb that ends below the level set
            for its leg is flagged in amber with that level. */}
        {!dragging && phaseShown.map((p, k) => {
          const pl = phasePlaced.get(k)
          return (
            <g key={`phase-${k}`} pointerEvents="none">
              <circle cx={p.x} cy={p.y} r={3.5} fill="#fff" stroke="#000" strokeWidth={1.25} />
              {pl && <text x={pl.left} y={pl.baseline} textAnchor="start" fontSize={11} fontWeight={700} fill={p.short ? PHASE_SHORT_COLOR : '#fff'} {...HALO}>{p.text}</text>}
            </g>
          )
        })}
        </>)}
        {showMsa && msaPath && <path d={msaPath} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth={3.5} />}
        {showMsa && msaPath && <path d={msaPath} fill="none" stroke={MSA_COLOR} strokeWidth={1.75} strokeDasharray="6 3" />}
        {!dragging && series.belowMsa.map((run, i) => (
          <path key={`below-${i}`} d={polylinePath(run, L.xOf, L.yOf)} fill="none" stroke={DANGER_COLOR} strokeWidth={2.5} />
        ))}
        {series.belowMsaNearField?.map((run, i) => (
          <path key={`below-near-${i}`} d={polylinePath(run, L.xOf, L.yOf)} fill="none" stroke={FLOWN_NEAR_FIELD_COLOR} strokeWidth={2.5} />
        ))}
        {/* Recording gaps: nothing is known in between, so a dashed bridge and a dot at each end. */}
        {flownParts?.gaps.map(([a, b], i) => (
          <g key={`gap-${i}`} pointerEvents="none">
            <line x1={L.xOf(a.distNm)} y1={L.yOf(a.altFt)} x2={L.xOf(b.distNm)} y2={L.yOf(b.altFt)} stroke={FLOWN_GAP_COLOR} strokeWidth={2} strokeDasharray="3 3" />
            <circle cx={L.xOf(a.distNm)} cy={L.yOf(a.altFt)} r={3.5} fill={FLOWN_GAP_COLOR} stroke="#000" strokeWidth={1} />
            <circle cx={L.xOf(b.distNm)} cy={L.yOf(b.altFt)} r={3.5} fill={FLOWN_GAP_COLOR} stroke="#000" strokeWidth={1} />
          </g>
        ))}

        {/* ── Labels on top of every line (plan, MSA, below-MSA): chips, then obstacle names ── */}
        {renderAirspaceChips(placedChips)}
        {obstacleMarks.filter((m) => m.labelPos && m.leader).map((m) => (
          <line key={`lead-${m.key}`} x1={m.cx} y1={m.cy - 4} x2={m.cx} y2={m.labelPos!.baseline + 3} stroke={DANGER_TEXT} strokeWidth={1} strokeDasharray="2 2" opacity={0.8} />
        ))}
        {obstacleMarks.filter((m) => m.labelPos).map((m) => (
          <text key={`lim-${m.key}`} x={m.labelPos!.left} y={m.labelPos!.baseline} textAnchor="start" fontSize={12} fontWeight={700} fill={DANGER_TEXT} {...HALO}>
            {m.label}
          </text>
        ))}

        {poiMarks.filter((m) => m.labelPos).map((m) => (
          <text key={`poi-label-${m.key}`} x={m.labelPos!.left} y={m.labelPos!.baseline} textAnchor="start" fontSize={11} fontWeight={m.kind === 'aerodrome' ? 700 : 500} fill={CHART_TEXT} {...HALO} aria-hidden="true">{m.label}</text>
        ))}
        {/* ── Axes ──────────────────────────────────────────────── */}
        {renderYAxis(L, yTicks)}
        <line x1={L.plotLeft} y1={L.plotBottom} x2={L.plotRight} y2={L.plotBottom} stroke="var(--border-default)" />
        {xTicks.map((t, i) => windRow.tickLabelShown[i] !== false && (
          <text key={`xl-${t.label}`} x={L.xOf(t.nm)} y={L.plotBottom + 8} dy="0.71em" textAnchor="middle" fontSize={11} fill="var(--text-secondary)">
            {t.label}
          </text>
        ))}
        <text x={L.plotRight + 2} y={L.plotBottom + 15} dy="0.355em" textAnchor="end" fontSize={11} fill="var(--text-muted)">
          {distLabel(units.distance)}
        </text>
      </>
    )
  }, [profile, layout, series, yMax, yMin, yTicks, xTicks, terrainPts, terrainStops, weatherMarks, windRow, showWindAloft, showMsa, windAloft, iconMarkup, visibleWaypointTicks, units.distance, dragging, obstacleMarks, landmarkMarks, poiMarks, unreached, legSpanList, phaseMarks, flownParts, logMode, windOn, flownSpeed, showSpeed])

  if (!profile || !series || series.distNms.length === 0) {
    // A flight log shows its panel at once: building its profile (map data, terrain) takes a moment.
    if (!logMode) return null
    return (
      <div className={css.panel}>
        <div className={css.header}>
          <span className={css.title}>{title ?? 'FLIGHT LOG'}</span>
          {onClose && <button className={css.collapseBtn} onClick={onClose} title="Close the flight log" aria-label="Close the flight log">✕</button>}
        </div>
        <div className={css.loadingMsg} style={{ height: chartH }}>Building the profile along the flown track…</div>
      </div>
    )
  }

  // ── Live layer (re-rendered every GPS tick) ────────────────────────────────
  const L = layout
  const live = L && (
    <g pointerEvents="none">
      {currentDistNm != null && (
        <line x1={L.xOf(currentDistNm)} y1={L.plotTop} x2={L.xOf(currentDistNm)} y2={L.plotBottom}
          stroke={CHART_LINE} strokeWidth={1} strokeDasharray="3 3" />
      )}
      {/* Trajectory ticks — yellow dashed lines at 1/3/5 min or NM ahead,
          labelled just above the plot bottom (the top row holds waypoint names). */}
      {trajectoryTicks.map((t, i) => {
        const x = L.xOf(t.distNm)
        return (
          <g key={`traj-${i}`}>
            <line x1={x} y1={L.plotTop} x2={x} y2={L.plotBottom} stroke="rgba(250,204,21,0.70)" strokeWidth={1} strokeDasharray="3 3" />
            <text x={x} y={L.plotBottom - 3} textAnchor="middle" fontSize={9} fill="rgba(250,204,21,0.90)" {...HALO}>
              {trajectoryTickLabels[i]}
            </text>
          </g>
        )
      })}
      {/* Vertical-speed trajectory, clipped to the plot: a steep descent
          extrapolates below 0 ft and would run through the axis labels. */}
      <clipPath id="vr-plot-clip">
        <rect x={L.plotLeft} y={L.plotTop - 4} width={L.plotW} height={L.plotH + 8} />
      </clipPath>
      <g clipPath="url(#vr-plot-clip)">
      {/* Faded while the vertical speed is unknown (drawn as level flight). */}
      <g opacity={vspeedTrajectory.estimated ? 0.6 : 1}>
      {vspeedTrajectory.points.slice(1).map((p, i) => {
        const prev = vspeedTrajectory.points[i]
        const below = prev.below || p.below
        return (
          <line key={`vspeed-seg-${i}`}
            x1={L.xOf(prev.distNm)} y1={L.yOf(prev.altFt)} x2={L.xOf(p.distNm)} y2={L.yOf(p.altFt)}
            stroke={below ? DANGER_COLOR : vspeedAttitudeColor} strokeWidth={below ? 2.25 : 1.75} strokeDasharray="1 2" />
        )
      })}
      {vspeedTrajectory.points.slice(1).map((p, i) => (
        <circle key={`vspeed-dot-${i}`} cx={L.xOf(p.distNm)} cy={L.yOf(p.altFt)} r={p.below ? 3 : 2.5}
          fill={p.below ? DANGER_COLOR : vspeedAttitudeColor} />
      ))}
      </g>
      </g>
      {/* Aircraft silhouette; clamped to the altitude scale so it never leaves the plot. */}
      {currentDistNm != null && currentAltFt != null && (
        <g transform={`translate(${L.xOf(currentDistNm)},${L.yOf(Math.max(0, Math.min(yMax, currentAltFt)))}) rotate(${-trajectoryPitchDeg(
          vspeedTrajectory.points[0] && { x: L.xOf(vspeedTrajectory.points[0].distNm), y: L.yOf(vspeedTrajectory.points[0].altFt) },
          vspeedTrajectory.points[1] && { x: L.xOf(vspeedTrajectory.points[1].distNm), y: L.yOf(vspeedTrajectory.points[1].altFt) },
          vspeedTrajectory.estimated,
        )})`} aria-hidden="true">
          {silhouette.map((part, i) => (
            <path key={`ac-part-${i}`} d={part.d} fill={part.fill ?? 'white'} opacity={part.opacity} />
          ))}
        </g>
      )}
      {/* Map-driven crosshair (profile cursor from map hover/click) */}
      {crosshairDistNm != null && (
        <line x1={L.xOf(crosshairDistNm)} y1={L.plotTop} x2={L.xOf(crosshairDistNm)} y2={L.plotBottom}
          stroke="rgba(250,204,21,0.85)" strokeWidth={1.5} strokeDasharray="4 3" />
      )}
    </g>
  )

  return (
    <div className={`${css.panel} ${collapsed ? css.collapsed : ''}`}>
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className={css.header}>
        <span className={css.title}>{title ?? (logMode ? 'FLIGHT LOG' : 'VIRTUAL RADAR')}</span>
        <span className={css.totalDist}>
          {nmToDisplay(profile.totalNm, units.distance).toFixed(1)} {distLabel(units.distance)}
        </span>
        {logMode && (
          <span className={css.dragHint} title="Drag the aircraft along the flown line, or tap a spot on the chart, to read time, altitude and speed there">
            drag the aircraft to inspect
          </span>
        )}
        {flownGapInfo && flownGapInfo.count > 0 && (
          <span className={css.offTrackBadge} title="The recording has holes (GPS lost or the app suspended). Nothing is known about the flight there: drawn as a dashed red line between the two ends.">
            ⚠ {flownGapInfo.count} GPS gap{flownGapInfo.count > 1 ? 's' : ''}, longest {formatElapsed(flownGapInfo.largestMs)}
          </span>
        )}
        {flownEntries.length > 0 && (
          <span className={css.logBadge} title={'Airspace entered (from the limits as drawn, approximate; not proof of an infringement):\n'
            + flownEntries.map((e) => `${formatElapsed(e.point.elapsedMs)}  ${e.band.class} ${e.band.name}`).join('\n')}>
            {flownEntries.length} airspace entr{flownEntries.length > 1 ? 'ies' : 'y'}
          </span>
        )}
        {onLegLevelChange && (
          <span className={css.dragHint} title="Press a leg on the chart and drag up or down to change its level">
            drag a leg to set its level
          </span>
        )}
        {terrainFailed && terrainPts.length === 0 && (
          <span className={`${css.offTrackBadge} ${css.wrapBadge}`} title={msaTerrain.fromGridOnly
            ? 'No elevation data could be loaded for this route. The MSA line comes from the terrain maximum grid (highest terrain per ~460 m cell, so conservative); there is no ground line and airspace limits given above ground (AGL) are drawn at their raw height.'
            : 'No elevation data could be loaded for this route. The MSA line is missing and airspace limits given above ground (AGL) are drawn at their raw height.'}>
            {msaTerrain.fromGridOnly ? '⚠ No ground line: MSA from the terrain grid, AGL limits at raw height' : '⚠ No terrain data: MSA unavailable, AGL limits at raw height'}
          </span>
        )}
        {/* Cross-track deviation badge — same reasoning as native's identical
            badge: this chart's terrain/airspace/MSA data is only ever sampled
            along the *planned* route, so once the aircraft has meaningfully
            diverged from it, what's drawn ahead of the "you are here" marker
            no longer reflects what's actually ahead of the aircraft. */}
        {crossTrackNm != null && Math.abs(crossTrackNm) > OFF_TRACK_BADGE_NM && (
          <span className={css.offTrackBadge}>⚠ {Math.abs(crossTrackNm).toFixed(1)}nm off track</span>
        )}
        {/* Winds aloft came back incomplete (Open-Meteo throttled or offline):
            say so instead of silently drawing fewer barbs. */}
        {windOn && windAloftStatus !== 'ok' && (
          <span
            className={css.windStatus}
            title={windAloftStatus === 'retrying'
              ? 'The wind forecast service is busy or unreachable. Some winds aloft are missing or older readings; retrying shortly.'
              : 'The wind forecast service is busy or unreachable. Some winds aloft are missing or older readings. Change the route or toggle WIND to try again.'}
          >
            {windAloftStatus === 'retrying' ? 'Winds: retrying…' : 'Winds unavailable'}
          </span>
        )}
        {canZoom && (
          <>
          <button className={css.projToggleBtn} onClick={() => zoomBy(1 / 1.5)} disabled={zoom <= 1} title="Zoom out (Ctrl + wheel, or pinch the chart)" aria-label="Zoom profile out">−</button>
          <button className={css.projToggleBtn} onClick={() => zoomBy(1.5)} title="Zoom in along the route (Ctrl + wheel, or pinch the chart)" aria-label="Zoom profile in">+</button>
          </>
        )}
        <button
          className={`${css.projToggleBtn} ${showMsa ? css.projToggleOn : ''}`}
          onClick={() => setShowMsa((v) => !v)}
          title={showMsa ? 'Hide the minimum safe altitude line' : 'Show the minimum safe altitude line'}
        >
          MSA
        </button>
        <button
          className={`${css.projToggleBtn} ${showObstLabels ? css.projToggleOn : ''}`}
          onClick={() => setShowObstLabels((v) => !v)}
          title={showObstLabels ? 'Hide obstacle height labels' : 'Show height labels on the obstacles near your level'}
        >
          OBST
        </button>
        {logMode && (
          <button
            className={`${css.projToggleBtn} ${showSpeed ? css.projToggleOn : ''}`}
            onClick={() => setShowSpeed((v) => !v)}
            title={showSpeed
              ? `Ground-speed line: own scale, 0 kt at the bottom of the chart to ${flownSpeed?.scale.topKts ?? 0} kt at the top. Click to hide.`
              : 'Show the ground speed along the flight (own scale)'}
          >
            {showSpeed && flownSpeed ? `GS 0–${flownSpeed.scale.topKts}` : 'GS'}
          </button>
        )}
        {!logMode && (
          <button
            className={`${css.projToggleBtn} ${showWindAloft ? css.projToggleOn : ''}`}
            onClick={() => setShowWindAloft((v) => !v)}
            title={showWindAloft ? 'Hide winds aloft' : 'Show winds aloft at several levels'}
          >
            WIND
          </button>
        )}
        <button
          className={css.collapseBtn}
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand Virtual Radar' : 'Collapse Virtual Radar'}
        >
          {collapsed ? '▲' : '▼'}
        </button>
        {onClose && (
          <button className={css.collapseBtn} onClick={onClose} title="Close the flight log" aria-label="Close the flight log">✕</button>
        )}
      </div>

      {/* ── Chart ──────────────────────────────────────────────────── */}
      {!collapsed && (
        <div className={css.chartWrap} ref={chartWrapRef} style={{ height: chartH + 18 }}>
          {L?.scrollable && <span className={css.scrollHint}>↔ scroll</span>}
          {L && (
            <div className={css.chartContent} style={{ width: L.contentW, height: chartH }}>
              {/* Pinned altitude scale: stuck to the left edge while the chart
                  scrolls, on an opaque panel-coloured backing so scrolled
                  content disappears at the axis instead of scrolling the FL
                  scale away. Only rendered when the chart actually scrolls. */}
              {L.scrollable && (
                <div className={css.yAxisPinned} aria-hidden style={{ height: chartH, marginBottom: -chartH, clipPath: `inset(0 0 ${MARGIN.bottom - 2}px 0)` }}>
                  <svg width={MARGIN.left} height={chartH}>{renderYAxis(L, yTicks)}</svg>
                </div>
              )}
              <svg className={css.chartSvg} width={L.contentW} height={chartH} role="img" aria-label={logMode ? 'Vertical profile of the flown track' : 'Vertical profile of the route'}>
                {scene}
                {live}
              </svg>
              {flown
                ? <FlownScrubOverlay layout={L} series={series} flown={flown} bands={profile.airspaceBands} silhouette={silhouette} onHoverDistNm={onHoverDistNm} jumpTo={jumpTo} />
                : <HoverOverlay layout={L} series={series} onHoverDistNm={onHoverDistNm} />}
              {profile && series && !logMode && (
                <LegDragLayer
                  layout={L}
                  spans={legSpanList}
                  legMsa={legMsaFt}
                  totalNm={profile.totalNm}
                  fallbackAltFt={aircraftProfile?.cruiseAltFt || 3500}
                  ceilingFt={Math.min(aircraftProfile?.serviceCeilingFt || 50_000, Math.round(yMax / 100) * 100)}
                  legOverrides={legOverrides}
                  plannedPts={plannedPts}
                  previewPts={dragPreviewPts}
                  chipBoxes={chipBoxes}
                  onLegLevelChange={onLegLevelChange}
                  drag={legDrag}
                  setDrag={setLegDrag}
                />
              )}
            </div>
          )}
        </div>
      )}

    </div>
  )
}

// Memoised: MapView re-renders every GPS tick, the chart only when its props change.
export default memo(VirtualRadar)
