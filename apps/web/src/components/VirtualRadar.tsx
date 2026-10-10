import { memo, useEffect, useMemo, useState, useRef } from 'react'
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  ReferenceDot,
  ReferenceArea,
  Tooltip,
  ResponsiveContainer,
  useXAxisScale,
  useYAxisScale,
} from 'recharts'
import { airspaceOutlines, airspaceChips, layoutAirspaceChips, type OutlineShape, type OutlineChip } from '@open-vfr/shared/airspaceOutline'
import {
  cloudLayerPaths, cloudLayerLabel, cloudGlyphHeight, cloudOpacityForOffset, cloudReportOffRouteNm,
  cloudReportIcao, cloudStripHalfWidthNm, placeCloudLabel, type LabelRect,
} from '@open-vfr/shared/cloudGlyph'
import { CLOUD_COLORS } from '@open-vfr/shared/featureColors'
import type { ParsedCloudLayer } from '@open-vfr/shared/fetchWx'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { LegOverride } from '../db/index'
import { type Units, DEFAULT_UNITS, nmToDisplay, distLabel } from '../utils/units'
import {
  buildVirtualRadarProfile, applyTerrainToBands, fetchTerrainProfile, projectFlightPath, DEFAULT_PERF_MODEL, computeMsaProfile, terrainAt,
  getMsaLookup, computeTrajectoryTicks, computeVspeedTrajectory, projectWeatherMarks,
  type TerrainPoint, type MsaPoint, type AircraftPerfModel,
} from '@open-vfr/shared/virtualRadarCalc'
import { resolveStationWeather } from '@open-vfr/shared/parseTaf'
import { getRemoteDem } from '../utils/terrainDem'
import { windBarbColorForSpeed, windBarbGeometry } from '@open-vfr/shared/windBarb'
import type { AircraftProfileDocType } from '../db/index'
import type { RouteWeatherStation } from '../hooks/useWeatherAlongRoute'
import { layoutWindRow, type WindRowItem } from '@open-vfr/shared/windRow'
import { useWindAloftAlongRoute } from '../hooks/useWindAloftAlongRoute'
import css from './VirtualRadar.module.css'
import { loadCountryGeojson } from '@open-vfr/shared/countryData'
import { useActiveCountries } from '../utils/countryData'
import { OBSTACLE_ICON_DEFS, OBSTACLE_ICON_FALLBACK_DEF } from '../utils/obstacleIcons'
import { LANDMARK_ICON_DEFS } from '../utils/landmarkIcons'
import { loadColoredSvgMarkup } from '../utils/svgIconLoader'
import { getAircraftSilhouette } from '@open-vfr/shared/aircraftSilhouette'

// Don't compress a long route down to fit the panel width —
// below this pixel-per-NM density the chart becomes horizontally scrollable
// instead (see chartWrap/scroll wiring below), matching native's identical
// MIN_PX_PER_NM constant in VerticalProfile.tsx.
// Bumped 18->30 -- at 18, almost any panel wide enough to show the
// sidebar comfortably fits a 40-50nm route without ever needing to scroll
// (900px/18 = 50nm), so the scroll path effectively never activated for
// realistic route lengths even though waypoint/wind labels were visibly
// cramped well before that. 30 matches the density already showing label
// crowding in testing.
const MIN_PX_PER_NM = 30
// Cross-track deviation beyond which the chart badges itself as showing a
// route the aircraft is no longer actually on — matches native's constant.
const OFF_TRACK_BADGE_NM = 3
// Width of the axis-only twin chart behind the pinned FL-scale column. Only
// its left 40 px (margin.left 4 + YAxis width 36) show -- the column clips
// the rest -- but recharts draws no axis ticks for a near-zero-width plot.
const Y_AXIS_PIN_W = 120


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
}

// ---------------------------------------------------------------------------
// Step-function altitude lookup (planned altitude at any distance along route)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------
type TooltipEntry = { name?: string; value?: number; color?: string }

function fmtFt(ft: number): string {
  return ft >= 1000
    ? `FL${Math.round(ft / 100).toString().padStart(3, '0')}`
    : `${Math.round(ft)} ft`
}

const SERIES_LABELS: Record<string, string> = {
  alt:        'Plan',
  projected:  'Proj',
  projSafe:   'Proj',
  projDanger: 'Proj',
  msa:        'MSA',
  ground:     'GND',
}

function ProfileTooltip({ active, payload }: { active?: boolean; payload?: TooltipEntry[] }) {
  if (!active || !payload?.length) return null
  // Collect one entry per logical series (projSafe + projDanger → single 'Proj' row)
  const seen = new Set<string>()
  const rows: { label: string; ft: number; color: string }[] = []
  for (const p of payload) {
    const key = p.name ?? ''
    const label = SERIES_LABELS[key]
    if (!label || p.value == null || p.value <= 0) continue
    const dedupeKey = label  // collapse projSafe/projDanger → 'Proj'
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    rows.push({ label, ft: p.value, color: (p.color as string) ?? 'var(--text-secondary)' })
  }
  if (rows.length === 0) return null
  rows.sort((a, b) => b.ft - a.ft)
  return (
    <div className={css.tooltip}>
      {rows.map((r) => (
        <div key={r.label} className={css.tooltipRow}>
          <span className={css.tooltipLabel} style={{ color: r.color }}>{r.label}</span>
          <span className={css.tooltipVal}>{fmtFt(r.ft)}</span>
        </div>
      ))}
    </div>
  )
}

// Shared size for BOTH the real-station and wind-sample barbs -- they used
// to differ (real bigger/bolder, sample smaller/dimmed) to visually flag
// "observed vs. estimated", but that read as one being broken/lower-
// quality rather than intentional. The "~" text prefix on samples is
// already the differentiator, so both now share identical geometry.
// The chart has no strip above the plot any more: every wind barb lives in one
// row just under the distance axis, sharing the band with the tick labels.
const CHART_TOP = 8
const CHART_BOTTOM = 2
const CHART_H = 162
/** Centre of the wind row, px below the plot bottom (inside the x axis's own 30px band). */
const WIND_ROW_Y = 15
/** Station barbs closer than this to a ground-model column replace it (observed beats model). */
// Edge barbs are nudged this far in from the plot edges (px): clears the "0"
// tick label on the left and the "NM" unit label on the right.
const WIND_ROW_EDGE_L_PX = 16
const WIND_ROW_EDGE_R_PX = 30
const WIND_ROW_STATION_SEP_NM = 6

/**
 * Renders a small WMO-style wind barb (shaft + pennant/full/half-barb
 * feathers) at the origin, pointing "up" before the caller's own rotate()
 * -- same geometry/reading convention as the map's wind-barb icons (see
 * @open-vfr/shared/windBarb's windBarbGeometry), just scaled down for this
 * chart. Replaces a plain arrow+triangle-head that only encoded speed via
 * colour/thickness -- found during a pre-release pass to be too subtle to
 * read strength from at a glance, unlike the map's actual barbs. Draws a
 * dark outline pass underneath the coloured pass first, same contrast fix
 * as the map icon, so it stays legible on both apps' basemaps.
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Airspace bands per style (see @open-vfr/shared/airspaceOutline): the area is
 *  filled once, and every sector keeps its own border except pieces lying inside
 *  another sector of the same kind (a higher floor drawn through a lower one).
 *  Rendered inside the chart's SVG using the axis scales. */
function AirspaceOutlines({ shapes, xFactor }: { shapes: OutlineShape[]; xFactor: (nm: number) => number }) {
  const xScale = useXAxisScale()
  const yScale = useYAxisScale()
  if (!xScale || !yScale) return null
  return (
    <g>
      {shapes.map((shape, i) => {
        const fillD = shape.loops
          .map((loop) => 'M' + loop.map(([nm, ft]) => `${xScale(xFactor(nm))},${yScale(ft)}`).join('L') + 'Z')
          .join(' ')
        const lineD = shape.segments
          .map(([x1, y1, x2, y2]) => `M${xScale(xFactor(x1))},${yScale(y1)}L${xScale(xFactor(x2))},${yScale(y2)}`)
          .join(' ')
        return (
          <g key={i}>
            <path d={fillD} fill={shape.fill} fillRule="evenodd" />
            {/* Thick translucent band hugging the inside of the edges (line clipped to the area). */}
            <clipPath id={`airspace-clip-${i}`}><path d={fillD} fillRule="evenodd" /></clipPath>
            <path d={lineD} fill="none" stroke={shape.border} strokeWidth={10} strokeOpacity={0.3} clipPath={`url(#airspace-clip-${i})`} />
            <path d={lineD} fill="none" stroke={shape.border} strokeWidth={1} strokeLinecap="square" />
          </g>
        )
      })}
    </g>
  )
}

/** Label chips at the top-left corner of each airspace band: class letter (or
 *  designator) in a coloured cell, then the first radio frequency. Laid out
 *  so neighbouring sectors' chips never cover each other (see
 *  layoutAirspaceChips). */
function AirspaceChips({ chips, xFactor }: { chips: OutlineChip[]; xFactor: (nm: number) => number }) {
  const xScale = useXAxisScale()
  const yScale = useYAxisScale()
  if (!xScale || !yScale) return null
  const placed = layoutAirspaceChips(chips, (nm) => xScale(xFactor(nm)) ?? 0, (ft) => yScale(ft) ?? 0)
  return (
    <g pointerEvents="none">
      {placed.map((p, i) => {
        const { chip: c, px: x, py: y, tagW, freqW, w, h } = p
        return (
          <g key={i}>
            <rect x={x} y={y} width={w} height={h} fill="#fff" stroke={c.border} strokeWidth={1} rx={1.5} />
            <rect x={x} y={y} width={tagW} height={h} fill={c.border} rx={1.5} />
            <text x={x + tagW / 2} y={y + 10} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="#fff">{c.tag}</text>
            {p.showFreq && <text x={x + tagW + freqW / 2} y={y + 10} textAnchor="middle" fontSize={9.5} fontWeight={600} fill="#111">{c.freq}</text>}
          </g>
        )
      })}
    </g>
  )
}

interface CloudMark {
  distNm: number
  offRouteNm: number
  station: RouteWeatherStation
  clouds: ParsedCloudLayer[]
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
function CloudLayers({ marks, chips, totalNm, yMax, xFactor }: {
  marks: CloudMark[]; chips: OutlineChip[]; totalNm: number; yMax: number; xFactor: (nm: number) => number
}) {
  const xScale = useXAxisScale()
  const yScale = useYAxisScale()
  if (!xScale || !yScale) return null
  const xOf = (nm: number) => xScale(xFactor(nm)) ?? 0
  const yOf = (ft: number) => yScale(ft) ?? 0
  const plotTop = yOf(yMax), plotBottom = yOf(0)
  const taken: LabelRect[] = layoutAirspaceChips(chips, xOf, yOf).map((p) => ({ x: p.px, y: p.py, w: p.w, h: p.h }))
  const halfWidthNm = cloudStripHalfWidthNm(totalNm)
  const shapes: React.ReactNode[] = []
  const labels: React.ReactNode[] = []
  marks.forEach((m, i) => {
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
        <path key={`cloud-${i}-${j}-${k}`} d={d} opacity={opacity}
          fill={accent ? 'url(#cloudGradConvective)' : 'url(#cloudGrad)'}
          stroke={accent ?? CLOUD_COLORS.stroke} strokeWidth={accent ? 1.25 : 0.75} />,
      ))
      const text = cloudLayerLabel(c) + (j === 0 ? ` ${cloudReportIcao(m.station)}` : '')
      const glyphH = Math.min(cloudGlyphHeight(c), yb - plotTop)
      const y = placeCloudLabel(cx, yb, glyphH, text, taken, plotTop, plotBottom)
      labels.push(
        <text key={`cloud-label-${i}-${j}`} x={cx} y={y} textAnchor="middle" fontSize={9} opacity={opacity}
          fill={accent ?? CLOUD_COLORS.label} stroke="rgba(0,0,0,0.75)" strokeWidth={3} strokeLinejoin="round" paintOrder="stroke">
          {text}
        </text>,
      )
    })
  })
  return <g pointerEvents="none">{shapes}{labels}</g>
}

function VirtualRadar({
  waypoints, legOverrides, units = DEFAULT_UNITS, title, onHoverDistNm, aircraftProfile,
  currentDistNm, currentAltFt, currentSpeedKts, currentVSpeedFpm, trajectoryMode, crosshairDistNm,
  crossTrackNm, weatherStations, airspaceCeilingFt,
}: Props) {

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
  const [terrainPts, setTerrainPts] = useState<TerrainPoint[]>([])
  // Neither the elevation API nor the hillshade DEM could supply terrain:
  // no ground line, no MSA, AGL bands at raw height. Said on the chart.
  const [terrainFailed, setTerrainFailed] = useState(false)
  const [msaPts,     setMsaPts]     = useState<MsaPoint[]>([])
  const [collapsed, setCollapsed]         = useState(false)
  const [showProjection, setShowProjection] = useState(false)
  const [showWindAloft, setShowWindAloft] = useState(true)
  const hoverRef = useRef<number | null>(null)

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
  }, [countriesKey])

  // Fetch terrain profile whenever the route changes
  const routeKey = waypoints.map((w) => `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`).join('|')
  useEffect(() => {
    if (waypoints.length < 2) {
      setTerrainPts([])
      setMsaPts([])
      return
    }
    const controller = new AbortController()
    setTerrainPts([])  // clear stale terrain while new fetch is in progress
    setTerrainFailed(false)
    fetchTerrainProfile(waypoints, '', controller.signal, getRemoteDem())
      .then((pts) => {
        setTerrainPts(pts)
        setMsaPts(computeMsaProfile(pts))
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') {
          console.warn('Terrain fetch failed:', err)
          setTerrainFailed(true)
        }
      })
    return () => controller.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey])

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
    )
  }, [waypoints, legOverrides, airspaceGeo, obstacleGeo, waterGeo, landmarkGeo, airspaceCeilingFt, aircraftProfile?.cruiseAltFt])
  // AGL limits are published as heights: lift them onto the terrain along the
  // crossing once the terrain profile is in, so bands draw at their real altitude.
  const profile = useMemo(
    () => rawProfile && { ...rawProfile, airspaceBands: applyTerrainToBands(rawProfile.airspaceBands, terrainPts) },
    [rawProfile, terrainPts],
  )

  // Load (and cache) the recoloured SVG markup for every obstacle/landmark
  // kind actually present on this route — same pictograms as the main map
  // (OBSTACLE_ICON_DEFS/LANDMARK_ICON_DEFS), rendered inline below via a
  // nested <svg> (valid SVG-in-SVG) instead of the generic glyph/dot labels
  // this chart used before.
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
        .catch(() => { /* non-fatal — falls back to a plain dot below */ })
    }
    return () => { cancelled = true }
  }, [profile, iconMarkup])

  // MSA lookup at a given distNm — shared with native (getMsaLookup) rather
  // than reimplemented here; this used to be a byte-for-byte duplicate.
  const getMsa = useMemo(() => getMsaLookup(msaPts), [msaPts])

  // Trajectory tick distances (NM along route) — mirrors the map trajectory
  // line marks. computeTrajectoryTicks is the same shared function native
  // uses; web's trajectoryMode is named 'time'|'dist' (native: 'time'|'nm')
  // so it's translated to the shared function's timeMode boolean here rather
  // than renaming this prop and touching every other trajectoryMode call site.
  const trajectoryTicks = useMemo(() => computeTrajectoryTicks({
    currentDistNm, currentSpeedKts, timeMode: trajectoryMode === 'time',
    marks: [1, 3, 5], totalNm: profile?.totalNm ?? 0,
  }), [currentDistNm, currentSpeedKts, trajectoryMode, profile])
  const trajectoryTickNms = useMemo(() => trajectoryTicks.map((t) => t.distNm), [trajectoryTicks])

  const trajectoryTickLabels = trajectoryMode === 'time'
    ? ['1m', '3m', '5m']
    : ['1nm', '3nm', '5nm']

  // Climb/descent-aware trajectory line — same shared
  // domain math as native's VerticalProfile, just rendered via Recharts
  // ReferenceLine segments/ReferenceDot below instead of react-native-svg Path.
  const vspeedTrajectory = useMemo(() => computeVspeedTrajectory({
    currentDistNm, currentAltFt, currentVSpeedFpm, ticks: trajectoryTicks, getMsa,
  }), [currentDistNm, currentAltFt, currentVSpeedFpm, trajectoryTicks, getMsa])
  const vspeedAttitudeColor =
    vspeedTrajectory.attitude === 'climb'   ? 'rgba(34,197,94,0.85)'   :
    vspeedTrajectory.attitude === 'descent' ? 'rgba(248,113,113,0.85)' :
                                               'var(--text-secondary)'
  const VSPEED_DANGER_COLOR = 'rgba(239,68,68,0.95)'

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


  // Measure the chart wrap's width — needed to decide whether the route is
  // wider than the panel (MIN_PX_PER_NM) and therefore should scroll instead
  // of Recharts' ResponsiveContainer squeezing the whole route into 100%.
  // Deps deliberately NOT [] -- chartWrapRef.current is null on this
  // component's very first commit (profile/chartData aren't ready yet, so
  // the early `if (!profile...) return null` below skips rendering the div
  // entirely that first time). An empty-deps effect only ever runs once,
  // right after that first (contentless) commit, sees el=null, and bails
  // forever -- wrapW then stays stuck at its initial 0 for the component's
  // whole lifetime, silently forcing the width:100% fallback below even
  // though `scrollable` (computed from wrapW too) can still evaluate true
  // and show the "scroll" hint span: the hint renders but nothing actually
  // overflows to scroll. Re-running whenever collapsed or chartData's
  // readiness changes re-attempts the el lookup at each point the div
  // could newly exist (profile arriving, or expanding after a collapse).
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

  // Build chart data: terrain points as the primary series (evenly spaced),
  // with planned altitude step-function interpolated at each distance.
  // Falls back to altitude-only points while terrain is loading.
  const chartData = useMemo(() => {
    if (!profile) return []
    if (terrainPts.length > 0) {
      const sampleDists = terrainPts.map((p) => p.distNm)
      // Use terrain elevation at the first and last sample points as departure /
      // arrival aerodrome elevation so the projected path starts and ends on the
      // ground rather than at 0 ft MSL.
      const depElevFt = terrainPts[0]?.elevFt ?? 0
      const arrElevFt = terrainPts[terrainPts.length - 1]?.elevFt ?? 0
      // Always compute projected path when perf is available — used for the
      // purple altitude line regardless of PROJ toggle so the chart always
      // shows when the aircraft reaches planned cruise altitude per leg.
      const projAlts = perf
        ? projectFlightPath(profile.altitudeProfile, profile.totalNm, perf, sampleDists, depElevFt, arrElevFt)
        : null
      // Suppress the MSA danger flag within 5 NM of departure or arrival —
      // climbing through MSA on departure and descending through it on approach
      // are normal operations, not a terrain clearance warning.
      // Planned line: linear ramp from departure elevation to first-leg
      // altitude and down to arrival elevation (generic model if no perf).
      const plannedAlts = projectFlightPath(profile.altitudeProfile, profile.totalNm, perf ?? DEFAULT_PERF_MODEL, sampleDists, depElevFt, arrElevFt)
      const SUPPRESS_NM = 5

      // First pass: compute per-point values and belowMsa flag.
      const raw = terrainPts.map(({ distNm, elevFt }, i) => {
        const proj = projAlts ? projAlts[i] : undefined
        const msa  = getMsa(distNm)
        const nearEndpoint = distNm < SUPPRESS_NM || (profile.totalNm - distNm) < SUPPRESS_NM
        const belowMsa = proj != null && msa > 0 && proj < msa && !nearEndpoint
        const plannedAlt = plannedAlts[i]
        return { distNm, elevFt, proj, msa, belowMsa, plannedAlt }
      })

      // Second pass: include transition points in BOTH series so cyan and red
      // lines meet at their boundary rather than leaving a gap.
      return raw.map(({ distNm, elevFt, proj, msa, belowMsa, plannedAlt }, i) => {
        const prevBelow = i > 0 ? raw[i - 1].belowMsa : belowMsa
        const nextBelow = i < raw.length - 1 ? raw[i + 1].belowMsa : belowMsa
        const isTransition = prevBelow !== belowMsa || nextBelow !== belowMsa
        return {
          dist:       nmToDisplay(distNm, units.distance),
          alt:        plannedAlt,
          ground:     elevFt,
          msa:        msa > 0 ? msa : undefined,
          projected:  proj,
          // At a safe↔danger transition, include the point in both series so
          // the two coloured lines share an endpoint and connect without a gap.
          projSafe:   (showProjection && proj != null && (!belowMsa || isTransition)) ? proj : undefined,
          projDanger: (showProjection && proj != null && (belowMsa  || isTransition)) ? proj : undefined,
        }
      })
    }
    // Fallback while terrain loads
    return profile.altitudeProfile.map((p) => ({
      dist:       nmToDisplay(p.distNm, units.distance),
      alt:        p.altFt,
      ground:     0,
      msa:        undefined,
      projected:  undefined,
      projSafe:   undefined,
      projDanger: undefined,
    }))
  }, [profile, terrainPts, units.distance, perf, showProjection])

  // Y-axis ceiling: scale to 1.5× planned alt, but always clear the terrain.
  const yMax = useMemo(() => {
    if (!profile) return 10000
    const planned    = Math.max(profile.maxPlannedAltFt, 1000)
    const maxTerrain = terrainPts.reduce((m, p) => Math.max(m, p.elevFt), 0)
    const raw        = Math.max(planned * 1.5, maxTerrain * 1.2, 3000)
    return Math.ceil(raw / 1000) * 1000
  }, [profile, terrainPts])

  // Winds aloft at the standard levels up to the chart top, one column every
  // ~20 NM -- SkyDemon-style, so the best level for the wind is visible at a
  // glance. Model data (Open-Meteo), nominal ISA height of each pressure level.
  const windAloft = useWindAloftAlongRoute(waypoints, profile?.totalNm ?? 0, yMax, showWindAloft)

  // Terrain gradient stops — elevation bands mapped to SVG y (0%=top=yMax, 100%=bottom=0ft).
  // blue sea level → green lowland → brown hills → grey mountains
  const terrainStops = useMemo(() => [
    { elev: yMax,  color: 'rgba(85,82,78,0.72)'  },  // grey rock (peak / top of chart)
    { elev: 3000,  color: 'rgba(108,84,52,0.65)' },  // brown highland
    { elev: 1000,  color: 'rgba(82,100,54,0.58)' },  // mixed hill
    { elev: 300,   color: 'rgba(52,92,46,0.52)'  },  // green lowland
    { elev: 50,    color: 'rgba(38,85,42,0.48)'  },  // coastal green
    { elev: 0,     color: 'rgba(30,80,140,0.55)' },  // blue — sea level / water
  ].map(({ elev, color }) => ({
    offset: `${Math.max(0, Math.min(100, (1 - elev / yMax) * 100)).toFixed(1)}%`,
    color,
  })), [yMax])

  // Scrollable chart: content width grows past the measured
  // panel width (wrapW) once the route needs more than MIN_PX_PER_NM per NM
  // to stay legible, instead of Recharts' ResponsiveContainer always
  // squeezing the whole route down to 100%. Native's identical constant/
  // behaviour is in VerticalProfile.tsx; the mechanism differs (native drives
  // a manual PanResponder + translateX, since RN has no scroll-view-over-SVG
  // story that plays nicely with a competing pan gesture; web just uses a
  // plain scrollable div, since the browser's native horizontal scroll
  // doesn't have that gesture-conflict problem).
  const totalNmDisplay = profile ? nmToDisplay(profile.totalNm, units.distance) : 0
  const contentPxWidth = Math.max(wrapW, totalNmDisplay * MIN_PX_PER_NM)
  const scrollable = contentPxWidth > wrapW + 0.5
  // Right edge of the actual plot area in px -- used by the wind-arrow
  // blocks below to decide whether the dir/speed text fits to the right of
  // the arrow (12 = ComposedChart's margin.right).
  // X-axis tick/unit-label collision avoidance \u2014 XAxis's `label` prop
  // ("NM"/"km", position: 'insideRight') is pinned to the axis's right
  // edge regardless of where the highest auto-generated tick (previously
  // tickCount=8, evenly spaced across [0, domainMax]) happens to land.
  // domainMax is Math.ceil(totalNm) so it essentially never lands exactly
  // on a "nice" tick boundary -- Recharts' auto ticks routinely place one
  // within a couple px of the right edge, painting that number's text
  // directly under/through the unit label (e.g. "36" smeared into "NM").
  // Generate our own evenly-spaced ticks instead and drop any that land in
  // the last ~8% of the domain, reserving that strip for the unit label --
  // same fixed-budget edge-clamp tradeoff already used above for the wind-
  // arrow x position and below for waypoint-label collision avoidance.
  const xAxisTicks = useMemo(() => {
    const domainMax = Math.max(1, Math.ceil(totalNmDisplay))
    const TICK_COUNT = 8
    const EDGE_RESERVE_FRAC = 0.08
    const step = domainMax / (TICK_COUNT - 1)
    const out: number[] = []
    for (let i = 0; i < TICK_COUNT; i++) {
      const v = Math.round(i * step)
      if (v > domainMax * (1 - EDGE_RESERVE_FRAC)) break
      if (out[out.length - 1] !== v) out.push(v)
    }
    return out
  }, [totalNmDisplay])

  // ── Wind row (just under the x axis) ───────────────────────────────────────
  // METAR/TAF station barbs plus, with the WIND toggle on, the ground (10 m)
  // model barb of every winds-aloft column that has no station nearby. Each
  // barb keeps its route position and degrades: dir/kt text -> barb only ->
  // not drawn, whenever it would overlap a tick label, another barb or the
  // chart edge (see @open-vfr/shared/windRow).
  type WindRowWind = { dirDeg: number | null; speedKt: number; calm: boolean }
  const windRow = (() => {
    if (!profile || totalNmDisplay <= 0) return []
    const pxPerUnit = contentPxWidth / totalNmDisplay
    const winds = new Map<string, { distNm: number; wind: WindRowWind; priority: number }>()
    for (const [i, m] of weatherMarks.entries()) {
      if (m.wind) winds.set(`st-${i}`, { distNm: m.distNm, wind: { dirDeg: m.wind.dirDeg ?? null, speedKt: m.wind.speedKt, calm: !!m.wind.calm }, priority: 0 })
    }
    if (showWindAloft) {
      const stationNms = weatherMarks.filter((m) => m.wind).map((m) => m.distNm)
      for (const [ci, col] of windAloft.entries()) {
        const g = col.levels.find((l) => l.surface)
        if (!g || stationNms.some((d) => Math.abs(d - col.distNm) < WIND_ROW_STATION_SEP_NM)) continue
        winds.set(`gr-${ci}`, { distNm: col.distNm, wind: { dirDeg: g.dirDeg, speedKt: g.speedKts, calm: g.speedKts === 0 }, priority: 1 })
      }
    }
    const labelOf = (w: WindRowWind) => w.calm ? 'CALM' : w.dirDeg == null ? '' : `${String(w.dirDeg).padStart(3, '0')}\u00b0/${w.speedKt}`
    const items: WindRowItem[] = [...winds.entries()].map(([key, v]) => ({
      key, priority: v.priority,
      // Clamped into the margin: departure/destination stations sit exactly on
      // the chart edges, and a small nudge keeps the barb clear of the "0" tick label (left)
      // and the "NM" unit label (right).
      px: Math.min(Math.max(nmToDisplay(v.distNm, units.distance) * pxPerUnit, WIND_ROW_EDGE_L_PX), totalNmDisplay * pxPerUnit - WIND_ROW_EDGE_R_PX),
      labelW: labelOf(v.wind).length * 10 * 0.62,
    }))
    const placed = layoutWindRow(items, {
      // The "0" tick is skipped: the departure METAR sits exactly there and
      // is the most useful barb on the row ("0" is self-evident).
      tickPx: xAxisTicks.filter((t) => t > 0).map((t) => t * pxPerUnit),
      minPx: WIND_ROW_EDGE_L_PX, maxPx: totalNmDisplay * pxPerUnit - WIND_ROW_EDGE_R_PX,
      leftLimitPx: 4, rightLimitPx: totalNmDisplay * pxPerUnit,
    })
    return placed.map((pl) => ({ ...pl, x: pl.px / pxPerUnit, wind: winds.get(pl.key)!.wind, text: labelOf(winds.get(pl.key)!.wind), model: pl.key.startsWith('gr-') }))
  })()

  // Waypoint-name label collision avoidance — closely-spaced waypoints
  // (e.g. a short leg to a named landmark waypoint) previously rendered
  // every ReferenceLine label regardless of pixel spacing, so adjacent
  // names ran into each other and became unreadable ("Kulla…Church"
  // mashed together). Skip a label if it would land within
  // MIN_WP_LABEL_GAP_PX of the last one actually KEPT (not just the last
  // one considered) — a rough fixed budget rather than measuring each
  // name's real text width, same tradeoff already made elsewhere in this
  // chart (e.g. the wind-arrow edge clamp above).
  const MIN_WP_LABEL_GAP_PX = 46
  const visibleWaypointTicks = useMemo(() => {
    if (!profile) return []
    const pxPerUnit = totalNmDisplay > 0 ? contentPxWidth / totalNmDisplay : 0
    // Seeded at 0 (the Y-axis's own pixel position), not -Infinity --
    // treats the axis/departure edge as an already-kept label competing
    // for the same MIN_WP_LABEL_GAP_PX budget. Without this, a SECOND
    // waypoint that's genuinely very close to departure (e.g. a VRP named
    // after a literal landmark right by the airfield, common on Swedish
    // VFR charts -- "Church", "Tolånga kyrka") had nothing before it to
    // collide against, so it always rendered regardless of how close to
    // x=0 it was, overlapping the Y-axis/FL-scale margin instead of
    // sitting cleanly inside the plot -- reported as the label rendering
    // "outside the chart" on both platforms.
    let lastX = 0
    const out: typeof profile.waypointTicks = []
    profile.waypointTicks.forEach((tick, i) => {
      if (i === 0) return // departure skipped, same as before -- sits on Y-axis
      const x = nmToDisplay(tick.distNm, units.distance) * pxPerUnit
      if (x - lastX < MIN_WP_LABEL_GAP_PX) return
      out.push(tick)
      lastX = x
    })
    return out
  }, [profile, totalNmDisplay, contentPxWidth, units.distance])

  // Auto-follow the aircraft while flying, mirroring native: if its marker
  // has scrolled near/out of the visible window, re-center on it. Skipped
  // while a map-driven crosshair is active so it doesn't fight that.
  useEffect(() => {
    const el = chartWrapRef.current
    if (!el || !scrollable || currentDistNm == null || !profile || crosshairDistNm != null) return
    const markerX = (currentDistNm / profile.totalNm) * contentPxWidth
    const EDGE = 40
    if (markerX < el.scrollLeft + EDGE || markerX > el.scrollLeft + wrapW - EDGE) {
      el.scrollTo({ left: Math.max(0, Math.min(contentPxWidth - wrapW, markerX - wrapW / 2)), behavior: 'smooth' })
    }
  }, [currentDistNm, scrollable, profile, contentPxWidth, wrapW, crosshairDistNm])

  if (!profile || chartData.length === 0) return null

  return (
    <div className={`${css.panel} ${collapsed ? css.collapsed : ''}`}>
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className={css.header}>
        <span className={css.title}>{title ?? 'VIRTUAL RADAR'}</span>
        <span className={css.totalDist}>
          {nmToDisplay(profile.totalNm, units.distance).toFixed(1)} {distLabel(units.distance)}
        </span>
        {/* Cross-track deviation badge — same reasoning as native's identical
            badge: this chart's terrain/airspace/MSA data is only ever sampled
            along the *planned* route, so once the aircraft has meaningfully
            diverged from it, what's drawn ahead of the "you are here" marker
            no longer reflects what's actually ahead of the aircraft. */}
        {terrainFailed && terrainPts.length === 0 && (
          <span className={css.offTrackBadge} title="No elevation data could be loaded for this route. The MSA line is missing and airspace limits given above ground (AGL) are drawn at their raw height.">
            ⚠ No terrain data: MSA unavailable, AGL limits at raw height
          </span>
        )}
        {crossTrackNm != null && Math.abs(crossTrackNm) > OFF_TRACK_BADGE_NM && (
          <span className={css.offTrackBadge}>⚠ {Math.abs(crossTrackNm).toFixed(1)}nm off track</span>
        )}
        {perf && (
          <button
            className={`${css.projToggleBtn} ${showProjection ? css.projToggleOn : ''}`}
            onClick={() => setShowProjection((v) => !v)}
            title={showProjection ? 'Hide performance projection' : 'Show performance projection'}
          >
            PROJ
          </button>
        )}
        <button
          className={`${css.projToggleBtn} ${showWindAloft ? css.projToggleOn : ''}`}
          onClick={() => setShowWindAloft((v) => !v)}
          title={showWindAloft ? 'Hide winds aloft' : 'Show winds aloft at several levels'}
        >
          WIND
        </button>
        <button
          className={css.collapseBtn}
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand Virtual Radar' : 'Collapse Virtual Radar'}
        >
          {collapsed ? '▲' : '▼'}
        </button>
      </div>

      {/* ── Chart ──────────────────────────────────────────────────── */}
      {!collapsed && (
        <div className={css.chartWrap} ref={chartWrapRef}>
          {scrollable && <span className={css.scrollHint}>↔ scroll</span>}
          <div style={{ width: wrapW > 0 ? contentPxWidth : '100%', height: '100%' }}>
          {/* Pinned FL scale: a 40 px axis-only twin of the chart below
              (same height, margins and axes, so its ticks line up exactly),
              stuck to the left edge while the chart scrolls, on an opaque
              panel-coloured backing so scrolled content disappears at the
              axis instead of scrolling the FL scale away. Only rendered
              when the chart actually scrolls. */}
          {scrollable && (
            <div className={css.yAxisPinned} aria-hidden>
              <ComposedChart width={Y_AXIS_PIN_W} height={CHART_H} data={chartData} margin={{ top: CHART_TOP, right: 0, bottom: CHART_BOTTOM, left: 4 }}>
                <XAxis dataKey="dist" type="number" domain={[0, Math.ceil(nmToDisplay(profile.totalNm, units.distance))]} tick={false} tickLine={false} axisLine={false} />
                <YAxis
                  domain={[0, yMax]}
                  tickCount={5}
                  tickFormatter={(v: number) => v >= 1000 ? `FL${Math.round(v / 100).toString().padStart(3,'0')}` : `${v}`}
                  tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                  tickLine={false}
                  axisLine={{ stroke: 'var(--border-default)' }}
                  width={36}
                />
                {/* Invisible series: recharts draws no axis ticks for an
                    axis that no graphical item uses. */}
                <Line dataKey="ground" stroke="none" dot={false} activeDot={false} isAnimationActive={false} />
              </ComposedChart>
            </div>
          )}
          <ResponsiveContainer width="100%" height={CHART_H}>
            <ComposedChart
              data={chartData}
              // top bumped 8->26px (chartWrap grew by the same 20px, see
              // VirtualRadar.module.css) to reserve real headroom above the
              // plot for wind arrows, which previously sat inside the plot's
              // own top strip fighting waypoint-name labels for the same
              // few pixels -- see the wind-arrow y comment below.
              margin={{ top: CHART_TOP, right: 12, bottom: CHART_BOTTOM, left: 4 }}
              onMouseMove={(e) => {
                const anyE = e as Record<string, unknown>
                if (anyE['activePayload'] && Array.isArray(anyE['activePayload']) && anyE['activePayload'][0]) {
                  const d = (anyE['activePayload'][0].payload as { dist: number }).dist
                  if (d !== hoverRef.current) {
                    hoverRef.current = d
                    onHoverDistNm?.(d)
                  }
                }
              }}
              onMouseLeave={() => {
                hoverRef.current = null
                onHoverDistNm?.(null)
              }}
            >
              {/* SVG defs must be first child so gradient IDs resolve before use */}
              <defs>
                <linearGradient id="terrainGrad" x1="0" y1="0" x2="0" y2="1">
                  {terrainStops.map((s, i) => (
                    <stop key={i} offset={s.offset} stopColor={s.color} />
                  ))}
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
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />

              <XAxis
                dataKey="dist"
                type="number"
                domain={[0, Math.ceil(nmToDisplay(profile.totalNm, units.distance))]}
                ticks={xAxisTicks}
                tickFormatter={(v: number) => `${v.toFixed(0)}`}
                tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                tickLine={false}
                axisLine={{ stroke: 'var(--border-default)' }}
                label={{ value: distLabel(units.distance), position: 'insideRight', offset: -2, fill: 'var(--text-faint)', fontSize: 10 }}
              />

              <YAxis
                domain={[0, yMax]}
                tickCount={5}
                tickFormatter={(v: number) => v >= 1000 ? `FL${Math.round(v / 100).toString().padStart(3,'0')}` : `${v}`}
                tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                tickLine={false}
                axisLine={{ stroke: 'var(--border-default)' }}
                width={36}
              />

              <Tooltip content={<ProfileTooltip />} />

              {/* ── Airspace bands ─────────────────────────────────── */}
              {/* Class/ceiling label removed for now — no dedup against
                  stacked sub-sectors sharing an identical ceiling (e.g.
                  multiple TMA sub-sectors all topping at FL095 but with
                  different floors) produced repeated, uninformative "TMA
                  FL095" tags. Y-position + band colour already encode
                  altitude/class; revisit with a floor–ceiling format + dedup
                  instead of re-adding as-is. */}
              {/* Airspace bands: merged outline per style, clamped to the plot's
                  top edge (a band topping above yMax, e.g. a TMA capped at
                  FL065 over a low route, must still draw). */}
              <AirspaceOutlines
                shapes={airspaceOutlines(profile.airspaceBands, yMax)}
                xFactor={(nm) => nmToDisplay(nm, units.distance)}
              />
              <AirspaceChips
                chips={airspaceChips(profile.airspaceBands, yMax)}
                xFactor={(nm) => nmToDisplay(nm, units.distance)}
              />

              <CloudLayers
                marks={weatherMarks}
                chips={airspaceChips(profile.airspaceBands, yMax)}
                totalNm={profile.totalNm}
                yMax={yMax}
                xFactor={(nm) => nmToDisplay(nm, units.distance)}
              />

              {/* ── Water (lake/reservoir) crossings ──────────────── */}
              {/* Thin blue band along the ground baseline wherever the route
                  crosses a lake/reservoir — marks that OpenTopoData's terrain
                  reading there is the water SURFACE, not solid ground. */}
              {profile.waterCrossings.map((wc, i) => {
                const spanElevs = terrainPts
                  .filter(p => p.distNm >= wc.entryNm && p.distNm <= wc.exitNm)
                  .map(p => p.elevFt)
                const spanMaxFt = Math.max(200, ...(spanElevs.length ? spanElevs : [0]))
                return (
                  <ReferenceArea
                    key={`water-${i}`}
                    x1={nmToDisplay(wc.entryNm, units.distance)}
                    x2={nmToDisplay(wc.exitNm,  units.distance)}
                    y1={0}
                    y2={spanMaxFt}
                    fill="rgba(30,100,200,0.35)"
                    stroke="rgba(60,140,230,0.7)"
                    strokeWidth={1}
                  />
                )
              })}

              {/* ── Obstacle markers at tip elevation, real map pictograms ──
                  Same obs-*.svg icons (recoloured via OBSTACLE_ICON_DEFS) the
                  main map and native's VerticalProfile both use — this used
                  to render a generic triangle/square glyph instead of the
                  actual per-kind symbols. */}
              {profile.obstacles.map((obs, i) => {
                const baseFt = Math.max(obs.elevationFt, terrainAt(terrainPts, obs.distNm))
                const tipFt = obs.heightM > 0
                  ? Math.round(baseFt + obs.heightM * 3.28084)
                  : baseFt
                const markup = iconMarkup[`obs:${obs.kind}`]
                const size = 16
                return (
                  <ReferenceDot
                    key={`obs-${i}`}
                    x={nmToDisplay(obs.distNm, units.distance)}
                    y={tipFt}
                    r={0}
                    fill="transparent"
                    stroke="none"
                    ifOverflow="visible"
                    shape={(dotProps) => {
                      const { cx = 0, cy = 0 } = dotProps as { cx?: number; cy?: number }
                      if (markup) {
                        // Anchor by the icon's BOTTOM edge at the tip point,
                        // growing UPWARD from it -- a top-anchor's fixed
                        // pixel height extends DOWNWARD from tipFt instead,
                        // which for a short/zero-height obstacle (tipFt near
                        // baseFt, itself near the chart floor) has nowhere
                        // to go but below true 0ft/ground -- same failure
                        // mode as the original center-anchor bug, just via a
                        // different path. Bottom-anchoring can only ever
                        // grow toward higher altitude, so it never renders
                        // below its own data point.
                        return (
                          <g
                            transform={`translate(${cx - size / 2},${cy - size})`}
                            dangerouslySetInnerHTML={{ __html: markup.replace('<svg', `<svg width="${size}" height="${size}"`) }}
                          />
                        )
                      }
                      // Loading fallback — plain dot, same style this chart used
                      // for every marker before the pictogram fetch existed.
                      return <circle cx={cx} cy={cy} r={3} fill="rgba(220,80,60,0.85)" stroke="rgba(0,0,0,0.4)" strokeWidth={1} />
                    }}
                  />
                )
              })}

              {/* Wind row under the x axis: station barbs + ground-model barbs,
                  laid out by layoutWindRow (see windRow above). */}
              {windRow.map((w) => (
                <ReferenceDot
                  key={`windrow-${w.key}`}
                  x={w.x} y={0} r={0} fill="transparent" stroke="none" ifOverflow="visible"
                  shape={(dotProps) => {
                    const { cx = 0, cy: cy0 = 0 } = dotProps as { cx?: number; cy?: number }
                    const cy = cy0 + WIND_ROW_Y
                    if (w.wind.dirDeg == null && !w.wind.calm) {
                      return <circle cx={cx} cy={cy} r={3} fill="none" stroke="rgba(250,204,21,0.7)" strokeWidth={1} strokeDasharray="1.5,1.5" />
                    }
                    const color = w.wind.calm ? 'rgba(203,213,225,0.95)' : windBarbColorForSpeed(w.wind.speedKt)
                    const shaftLen = 16
                    const fontSize = 10
                    const text = w.label === 'right'
                      ? <text x={cx + 9 + 4} y={cy + fontSize * 0.35} fontSize={fontSize} fill={color} stroke="rgba(0,0,0,0.75)" strokeWidth={3} strokeLinejoin="round" paintOrder="stroke">{w.text}</text>
                      : w.label === 'left'
                        ? <text x={cx - 9 - 4} y={cy + fontSize * 0.35} fontSize={fontSize} textAnchor="end" fill={color} stroke="rgba(0,0,0,0.75)" strokeWidth={3} strokeLinejoin="round" paintOrder="stroke">{w.text}</text>
                        : null
                    return (
                      <g aria-hidden="true" opacity={w.model ? 0.85 : 1}>
                        {w.wind.calm
                          ? <circle cx={cx} cy={cy} r={3} fill="none" stroke="rgba(148,163,184,0.8)" strokeWidth={1} />
                          : (
                            <g transform={`translate(${cx},${cy}) rotate(${w.wind.dirDeg}) translate(0, ${shaftLen / 2})`}>
                              {renderWindBarbShape(w.wind.speedKt, color, { shaftLen, barbLen: 7, halfLen: 4, barbGap: 4, strokeW: 1.5 })}
                            </g>
                          )}
                        {text}
                      </g>
                    )
                  }}
                />
              ))}

              {/* Winds aloft: barbs at each standard pressure level's nominal
                  altitude, one column every ~20 NM (useWindAloftAlongRoute).
                  Model forecast, so drawn dimmer than the station barbs. */}
              {showWindAloft && windAloft.flatMap((col, ci) => col.levels.map((lv) => {
                // Surface (10 m) wind is part of the wind row under the x axis.
                if (lv.surface || lv.altFt > yMax * 0.96) return null
                const yAlt = lv.altFt
                const pxPerUnit = totalNmDisplay > 0 ? contentPxWidth / totalNmDisplay : 0
                const edgeMargin = Math.min(pxPerUnit > 0 ? 24 / pxPerUnit : 0, totalNmDisplay / 2)
                const x = Math.min(Math.max(nmToDisplay(col.distNm, units.distance), edgeMargin), totalNmDisplay - edgeMargin)
                return (
                  <ReferenceDot
                    key={`windaloft-${ci}-${lv.altFt}`}
                    x={x} y={yAlt} r={0} fill="transparent" stroke="none" ifOverflow="visible"
                    shape={(dotProps) => {
                      const { cx = 0, cy = 0 } = dotProps as { cx?: number; cy?: number }
                      const shaftLen = 16
                      const color = windBarbColorForSpeed(lv.speedKts)
                      const label = lv.speedKts === 0 ? 'CALM' : `${String(lv.dirDeg).padStart(3, '0')}°/${lv.speedKts}`
                      return (
                        <g aria-hidden="true" opacity={0.85}>
                          {lv.speedKts === 0
                            ? <circle cx={cx} cy={cy} r={3} fill="none" stroke="rgba(148,163,184,0.8)" strokeWidth={1} />
                            : (
                              <g transform={`translate(${cx},${cy}) rotate(${lv.dirDeg}) translate(0, ${shaftLen / 2})`}>
                                {renderWindBarbShape(lv.speedKts, color, { shaftLen, barbLen: 7, halfLen: 4, barbGap: 4, strokeW: 1.5 })}
                              </g>
                            )}
                          <text
                            x={cx + shaftLen / 2 + 4} y={cy + 3} fontSize={9}
                            fill={color} stroke="rgba(0,0,0,0.75)" strokeWidth={3} strokeLinejoin="round" paintOrder="stroke"
                          >{label}</text>
                        </g>
                      )
                    }}
                  />
                )
              }))}

              {/* ── Landmark markers, floored at terrain, real map pictograms
                  Same lmk-*.svg icons (recoloured via LANDMARK_ICON_DEFS) the
                  main map and native's VerticalProfile both use — this used
                  to render a generic dot glyph instead of the actual symbols. */}
              {profile.landmarks.map((lmk, i) => {
                // Floor at 0 -- unlike obstacles (floored via Math.max
                // against their own surveyed elevationFt), landmarks have
                // no elevation of their own and rely purely on terrainAt(),
                // which can go negative from real DEM noise over/near water
                // (OpenTopoData EU-DEM, known water-surface artifact).
                // Unfloored, that rendered
                // the landmark's bottom-anchored icon below the chart's 0ft
                // baseline entirely.
                const baseFt = Math.max(0, terrainAt(terrainPts, lmk.distNm))
                const markup = iconMarkup[`lmk:${lmk.kind}`]
                const size = 14
                return (
                  <ReferenceDot
                    key={`lmk-${i}`}
                    x={nmToDisplay(lmk.distNm, units.distance)}
                    y={baseFt}
                    r={0}
                    fill="transparent"
                    stroke="none"
                    ifOverflow="visible"
                    shape={(dotProps) => {
                      const { cx = 0, cy = 0 } = dotProps as { cx?: number; cy?: number }
                      if (markup) {
                        // Anchor by the icon's BOTTOM edge, not its center —
                        // the lmk-*.svg viewBox draws the landmark top-down
                        // (roof/top at viewBox y=0, ground base at y=15), and
                        // (cx,cy) here is baseFt (ground). Centering split the
                        // glyph across the ground point, rendering half of it
                        // below true ground/0ft.
                        return (
                          <g
                            transform={`translate(${cx - size / 2},${cy - size})`}
                            dangerouslySetInnerHTML={{ __html: markup.replace('<svg', `<svg width="${size}" height="${size}"`) }}
                          />
                        )
                      }
                      return <circle cx={cx} cy={cy} r={2.5} fill="rgba(150,150,150,0.9)" stroke="rgba(0,0,0,0.4)" strokeWidth={1} />
                    }}
                  />
                )
              })}

              {/* ── Waypoint ticks ─────────────────────────────────── */}
              {/* Skip the departure tick (i=0) — it sits on the Y-axis and
                  the label overlaps the FL scale. The departure name is
                  implicit (leftmost edge of the chart). Renders
                  visibleWaypointTicks (collision-filtered above), not the
                  raw profile.waypointTicks list. */}
              {visibleWaypointTicks.map((tick) => (
                <ReferenceLine
                  key={`wp-${tick.distNm}-${tick.name}`}
                  x={nmToDisplay(tick.distNm, units.distance)}
                  stroke="var(--border-default)"
                  strokeWidth={1}
                  label={{
                    value: tick.name,
                    position: tick === profile!.waypointTicks[profile!.waypointTicks.length - 1] ? 'insideTopRight' : 'insideTopLeft',
                    fill: 'var(--text-secondary)',
                    fontSize: 10,
                  }}
                />
              ))}

              {/* ── Ground fill — elevation-banded gradient ─────────── */}
              <Area
                type="monotone"
                dataKey="ground"
                fill="url(#terrainGrad)"
                stroke="rgba(140,115,75,0.65)"
                strokeWidth={1}
                isAnimationActive={false}
                name="ground"
              />

              {/* ── Planned altitude line (linear so dep/arr ground ramps draw correctly) ─
                   When PROJ is on the cyan/red lines cover the same data, so
                   we make the purple line transparent to avoid visual overlap. */}
              <Line
                type="linear"
                dataKey="alt"
                stroke={(perf && showProjection) ? 'transparent' : '#e040fb'}
                strokeWidth={(perf && showProjection) ? 0 : 2}
                strokeDasharray={undefined}
                dot={false}
                isAnimationActive={false}
                name="alt"
              />

              {/* ── MSA line (dashed orange, when terrain data is available) ── */}
              {msaPts.length > 0 && (
                <Line
                  type="monotone"
                  dataKey="msa"
                  stroke="rgba(251,146,60,0.60)"
                  strokeWidth={1}
                  strokeDasharray="5 3"
                  dot={false}
                  isAnimationActive={false}
                  name="msa"
                  connectNulls
                />
              )}

              {/* ── Projected flight path (performance-based, toggleable) ── */}
              {/* Safe segments (cyan) — below-MSA points suppressed via projSafe */}
              {perf && showProjection && (
                <Line
                  type="linear"
                  dataKey="projSafe"
                  stroke="rgba(0,220,255,0.90)"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                  name="projSafe"
                  connectNulls={false}
                />
              )}
              {/* Below-MSA segments (red) */}
              {perf && showProjection && (
                <Line
                  type="linear"
                  dataKey="projDanger"
                  stroke="rgba(239,68,68,0.95)"
                  strokeWidth={2.5}
                  dot={false}
                  isAnimationActive={false}
                  name="projDanger"
                  connectNulls={false}
                />
              )}

              {/* ── Live position marker: vertical needle + aircraft silhouette + trajectory ticks ── */}
              {currentDistNm != null && (
                <ReferenceLine
                  x={nmToDisplay(currentDistNm, units.distance)}
                  stroke="var(--text-faint)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
              )}
              {currentDistNm != null && currentAltFt != null && (
                <ReferenceDot
                  x={nmToDisplay(currentDistNm, units.distance)}
                  y={currentAltFt}
                  r={0}
                  fill="transparent"
                  stroke="none"
                  shape={dotProps => {
                    const { cx = 0, cy = 0 } = dotProps as { cx?: number; cy?: number }
                    return (
                      <g transform={`translate(${cx},${cy})`} aria-hidden="true">
                        {silhouette.map((part, i) => (
                          <path key={`ac-part-${i}`} d={part.d} fill={part.fill ?? 'white'} opacity={part.opacity} />
                        ))}
                      </g>
                    )
                  }}
                />
              )}
              {/* Trajectory ticks — yellow dashed lines at 1/3/5 min or NM ahead of aircraft */}
              {trajectoryTickNms.map((distNm, i) => (
                <ReferenceLine
                  key={`traj-${i}`}
                  x={nmToDisplay(distNm, units.distance)}
                  stroke="rgba(250,204,21,0.70)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  label={{
                    value: trajectoryTickLabels[i],
                    position: 'top',
                    fill: 'rgba(250,204,21,0.90)',
                    fontSize: 9,
                  }}
                />
              ))}

              {vspeedTrajectory.points.slice(1).map((p, i) => {
                const prev = vspeedTrajectory.points[i]
                const below = prev.below || p.below
                return (
                  <ReferenceLine
                    key={`vspeed-seg-${i}`}
                    segment={[
                      { x: nmToDisplay(prev.distNm, units.distance), y: prev.altFt },
                      { x: nmToDisplay(p.distNm, units.distance),    y: p.altFt },
                    ]}
                    stroke={below ? VSPEED_DANGER_COLOR : vspeedAttitudeColor}
                    strokeWidth={below ? 2.25 : 1.75}
                    strokeDasharray="1 2"
                    ifOverflow="visible"
                  />
                )
              })}
              {vspeedTrajectory.points.slice(1).map((p, i) => (
                <ReferenceDot
                  key={`vspeed-dot-${i}`}
                  x={nmToDisplay(p.distNm, units.distance)}
                  y={p.altFt}
                  r={p.below ? 3 : 2.5}
                  fill={p.below ? VSPEED_DANGER_COLOR : vspeedAttitudeColor}
                  stroke="none"
                  ifOverflow="visible"
                />
              ))}

              {/* ── Map-driven crosshair (profile cursor from map hover/click) ── */}
              {crosshairDistNm != null && (
                <ReferenceLine
                  x={nmToDisplay(crosshairDistNm, units.distance)}
                  stroke="rgba(250,204,21,0.85)"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                />
              )}


            </ComposedChart>
          </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  )
}

// Memoised: MapView re-renders every GPS tick, the chart only when its props change.
export default memo(VirtualRadar)
