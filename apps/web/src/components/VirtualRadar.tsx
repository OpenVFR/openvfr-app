import { memo, useCallback, useEffect, useMemo, useState, useRef, type ReactNode } from 'react'
import { pickWaypointLabels, estimateLabelWidth } from '@open-vfr/shared/profileLabels'
import { airspaceOutlines, airspaceChips, layoutAirspaceChips } from '@open-vfr/shared/airspaceOutline'
import {
  cloudLayerPaths, cloudLayerLabel, cloudGlyphHeight, cloudOpacityForOffset, cloudReportOffRouteNm,
  cloudReportIcao, cloudStripHalfWidthNm, placeCloudLabel, type LabelRect,
} from '@open-vfr/shared/cloudGlyph'
import { CLOUD_COLORS } from '@open-vfr/shared/featureColors'
import type { ParsedCloudLayer } from '@open-vfr/shared/fetchWx'
import {
  profileChartLayout, profileYMax, altitudeTicks, formatAltitudeTick, distanceTicks,
  polylinePath, groundAreaPath, belowMsaRuns, nearestSampleIndex, type ProfileChartLayout,
} from '@open-vfr/shared/profileChart'
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
const CHART_H = 162
const MARGIN = { top: 8, right: 12, bottom: 32, left: 40 }
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

const PLAN_COLOR = '#e040fb'
const MSA_COLOR = 'rgba(251,146,60,0.60)'
const GROUND_COLOR = 'rgba(140,115,75,0.65)'
const DANGER_COLOR = 'rgba(239,68,68,0.95)'
const HALO = { stroke: 'rgba(0,0,0,0.75)', strokeWidth: 3, strokeLinejoin: 'round' as const, paintOrder: 'stroke' }


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

/** Per-sample series the chart lines and the hover readout are drawn from. */
interface ProfileSeries {
  distNms:     number[]
  plannedAlts: number[]
  /** Terrain elevation per sample; null while terrain is loading / unavailable. */
  ground:      number[] | null
  /** MSA per sample (0 = none). */
  msa:         number[] | null
  belowMsa:    { distNm: number; altFt: number }[][]
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
    return (
      <g key={`band-${i}`}>
        <path d={fillD} fill={shape.fill} fillRule="evenodd" />
        {/* Thick translucent band hugging the inside of the edges (line clipped to the area). */}
        <clipPath id={`airspace-clip-${i}`}><path d={fillD} fillRule="evenodd" /></clipPath>
        <path d={lineD} fill="none" stroke={shape.border} strokeWidth={10} strokeOpacity={0.3} clipPath={`url(#airspace-clip-${i})`} />
        <path d={lineD} fill="none" stroke={shape.border} strokeWidth={1} strokeLinecap="square" />
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
            <text x={x + tagW / 2} y={y + 10} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="#fff">{c.tag}</text>
            {p.showFreq && <text x={x + tagW + freqW / 2} y={y + 10} textAnchor="middle" fontSize={9.5} fontWeight={600} fill="#111">{c.freq}</text>}
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
function renderClouds(marks: CloudMark[], chips: ReturnType<typeof layoutAirspaceChips>, L: ProfileChartLayout) {
  const taken: LabelRect[] = chips.map((p) => ({ x: p.px, y: p.py, w: p.w, h: p.h }))
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
      const y = placeCloudLabel(cx, yb, glyphH, text, taken, L.plotTop, L.plotBottom)
      labels.push(
        <text key={`cloud-label-${i}-${j}`} x={cx} y={y} textAnchor="middle" fontSize={9} opacity={opacity}
          fill={accent ?? CLOUD_COLORS.label} {...HALO}>
          {text}
        </text>,
      )
    })
  })
  return <g pointerEvents="none">{shapes}{labels}</g>
}

/** Altitude axis: line on the plot's left edge plus FL/ft labels. Drawn in the
 *  chart and again in the pinned column while the chart scrolls. */
function renderYAxis(L: ProfileChartLayout, yTicks: number[]) {
  return (
    <g>
      <line x1={L.plotLeft} y1={L.plotTop} x2={L.plotLeft} y2={L.plotBottom} stroke="var(--border-default)" />
      {yTicks.map((ft) => (
        <text key={ft} x={L.plotLeft - 8} y={L.yOf(ft)} dy="0.355em" textAnchor="end" fontSize={10} fill="var(--text-muted)">
          {formatAltitudeTick(ft)}
        </text>
      ))}
    </g>
  )
}

// ---------------------------------------------------------------------------
// Hover readout
// ---------------------------------------------------------------------------

function fmtFt(ft: number): string {
  return ft >= 1000
    ? `FL${Math.round(ft / 100).toString().padStart(3, '0')}`
    : `${Math.round(ft)} ft`
}

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

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left
    if (px < L.plotLeft || px > L.plotRight) { update(null); return }
    update(nearestSampleIndex(series.distNms, L.nmAtX(px)))
  }

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
        <svg className={css.hoverSvg} width={L.contentW} height={CHART_H} aria-hidden>
          <line x1={x} y1={L.plotTop} x2={x} y2={L.plotBottom} stroke="var(--text-faint)" strokeWidth={1} />
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
                <span className={css.tooltipVal}>{fmtFt(r.ft)}</span>
              </div>
            ))}
          </div>
        )}
      </>
    )
  }

  return (
    <div
      className={css.hoverLayer}
      style={{ width: L.contentW, height: CHART_H }}
      onPointerMove={onMove}
      onPointerLeave={() => update(null)}
    >
      {content}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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
  const [showWindAloft, setShowWindAloft] = useState(true)

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
  const vspeedTrajectory = useMemo(() => computeVspeedTrajectory({
    currentDistNm, currentAltFt, currentVSpeedFpm, ticks: trajectoryTicks, getMsa,
  }), [currentDistNm, currentAltFt, currentVSpeedFpm, trajectoryTicks, getMsa])
  const vspeedAttitudeColor =
    vspeedTrajectory.attitude === 'climb'   ? 'rgba(34,197,94,0.85)'   :
    vspeedTrajectory.attitude === 'descent' ? 'rgba(248,113,113,0.85)' :
                                               'var(--text-secondary)'

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

  // Per-sample series: terrain samples when terrain is in (planned altitude
  // projected onto them), else the planned altitude breakpoints alone.
  const series = useMemo((): ProfileSeries | null => {
    if (!profile) return null
    if (terrainPts.length > 0) {
      const distNms = terrainPts.map((p) => p.distNm)
      // Departure / arrival elevation from the first and last terrain sample,
      // so the planned path starts and ends on the ground rather than at 0 ft.
      const depElevFt = terrainPts[0]?.elevFt ?? 0
      const arrElevFt = terrainPts[terrainPts.length - 1]?.elevFt ?? 0
      // Climb/descent follow the aircraft's performance (generic model without one).
      const plannedAlts = projectFlightPath(profile.altitudeProfile, profile.totalNm, perf ?? DEFAULT_PERF_MODEL, distNms, depElevFt, arrElevFt)
      return {
        distNms,
        plannedAlts,
        ground: terrainPts.map((p) => p.elevFt),
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
  }, [profile, terrainPts, perf, getMsa])

  const yMax = useMemo(
    () => (profile ? profileYMax(profile.maxPlannedAltFt, terrainPts) : 10000),
    [profile, terrainPts],
  )

  // Winds aloft at the standard levels up to the chart top, one column every
  // ~20 NM, so the best level for the wind is visible at a glance. Model data
  // (Open-Meteo), nominal ISA height of each pressure level.
  const windAloft = useWindAloftAlongRoute(waypoints, profile?.totalNm ?? 0, yMax, showWindAloft)

  const unitPerNm = nmToDisplay(1, units.distance)
  const layout = useMemo(() => (profile && wrapW > 0
    ? profileChartLayout({
      viewportW: wrapW, height: CHART_H, margin: MARGIN,
      totalNm: profile.totalNm, yMax, minPxPerNm: MIN_PX_PER_UNIT * unitPerNm,
    })
    : null), [profile, wrapW, yMax, unitPerNm])

  const yTicks = useMemo(() => altitudeTicks(yMax), [yMax])
  // Distance ticks on round display-unit values; the right end of the axis is
  // left free for the unit label (see distanceTicks).
  const xTicks = useMemo(() => {
    if (!layout) return []
    const target = Math.max(2, Math.round(layout.plotW / X_TICK_SPACING_PX))
    return distanceTicks(layout.totalNm * unitPerNm, target).map((v) => ({ label: v.toFixed(0), nm: v / unitPerNm }))
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
    if (showWindAloft) {
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
  }, [layout, weatherMarks, windAloft, showWindAloft, xTicks])

  // Waypoint-name label collision avoidance on the real label rectangles
  // (see @open-vfr/shared/profileLabels): names are variable-width and the
  // destination label is right-aligned to its line. The destination always
  // wins; the departure is skipped (it sits on the altitude axis).
  const visibleWaypointTicks = useMemo(() => {
    if (!profile || !layout) return []
    const ticks = profile.waypointTicks
    const lastIdx = ticks.length - 1
    const rects = ticks.map((t, i) => {
      const x = layout.xOf(t.distNm)
      const w = estimateLabelWidth(t.name, Infinity)
      return i === lastIdx
        ? { left: x - LINE_LABEL_INSET - w, right: x - LINE_LABEL_INSET }
        : { left: x + LINE_LABEL_INSET, right: x + LINE_LABEL_INSET + w }
    })
    return pickWaypointLabels(rects, layout.plotLeft).map((i) => ({ tick: ticks[i], isLast: i === lastIdx }))
  }, [profile, layout])

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

  // ── Static scene ───────────────────────────────────────────────────────────
  // Everything that only changes with the route, terrain, weather or panel
  // size. Memoised so the per-GPS-tick re-render (live layer below) only
  // rebuilds the aircraft marker and trajectory, not airspace, clouds, icons.
  const scene = useMemo(() => {
    if (!profile || !layout || !series) return null
    const L = layout
    const placedChips = layoutAirspaceChips(airspaceChips(profile.airspaceBands, yMax), L.xOf, L.yOf)
    const msaPath = series.msa
      ? polylinePath(series.distNms.flatMap((d, i) => (series.msa![i] > 0 ? [{ distNm: d, altFt: series.msa![i] }] : [])), L.xOf, L.yOf)
      : ''
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
          <linearGradient id="cloudGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={CLOUD_COLORS.fillTop}    stopOpacity={CLOUD_COLORS.fillTopOpacity} />
            <stop offset="100%" stopColor={CLOUD_COLORS.fillBottom} stopOpacity={CLOUD_COLORS.fillBottomOpacity} />
          </linearGradient>
          <linearGradient id="cloudGradConvective" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={CLOUD_COLORS.convectiveFillTop}    stopOpacity={CLOUD_COLORS.fillTopOpacity} />
            <stop offset="100%" stopColor={CLOUD_COLORS.convectiveFillBottom} stopOpacity={CLOUD_COLORS.fillBottomOpacity} />
          </linearGradient>
        </defs>

        {/* ── Grid ──────────────────────────────────────────────── */}
        <g stroke="var(--border-subtle)" strokeDasharray="3 3">
          {yTicks.map((ft) => <line key={`yg-${ft}`} x1={L.plotLeft} y1={L.yOf(ft)} x2={L.plotRight} y2={L.yOf(ft)} />)}
          {xTicks.map((t) => <line key={`xg-${t.label}`} x1={L.xOf(t.nm)} y1={L.plotTop} x2={L.xOf(t.nm)} y2={L.plotBottom} />)}
        </g>

        {/* ── Airspace bands + chips ────────────────────────────── */}
        {renderAirspace(profile.airspaceBands, L)}
        {renderAirspaceChips(placedChips)}

        {renderClouds(weatherMarks, placedChips, L)}

        {/* ── Water (lake/reservoir) crossings ──────────────────── */}
        {/* Thin blue band along the ground baseline wherever the route
            crosses a lake/reservoir — marks that the terrain reading there
            is the water SURFACE, not solid ground. */}
        {profile.waterCrossings.map((wc, i) => {
          const spanElevs = terrainPts
            .filter((p) => p.distNm >= wc.entryNm && p.distNm <= wc.exitNm)
            .map((p) => p.elevFt)
          const spanMaxFt = Math.min(yMax, Math.max(200, ...(spanElevs.length ? spanElevs : [0])))
          const x1 = L.xOf(wc.entryNm), x2 = L.xOf(wc.exitNm), yTop = L.yOf(spanMaxFt)
          return (
            <rect key={`water-${i}`} x={x1} y={yTop} width={Math.max(0, x2 - x1)} height={L.plotBottom - yTop}
              fill="rgba(30,100,200,0.35)" stroke="rgba(60,140,230,0.7)" strokeWidth={1} />
          )
        })}

        {/* ── Obstacles at tip elevation, real map pictograms ───── */}
        {profile.obstacles.map((obs, i) => {
          const baseFt = Math.max(obs.elevationFt, terrainAt(terrainPts, obs.distNm))
          const tipFt = obs.heightM > 0 ? Math.round(baseFt + obs.heightM * 3.28084) : baseFt
          const cx = L.xOf(obs.distNm), cy = L.yOf(tipFt)
          return renderIconAt(`obs-${i}`, cx, cy, 16, iconMarkup[`obs:${obs.kind}`],
            <circle cx={cx} cy={cy} r={3} fill="rgba(220,80,60,0.85)" stroke="rgba(0,0,0,0.4)" strokeWidth={1} />)
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
              {w.label === 'right' && <text x={cx + 13} y={ty} fontSize={10} fill={color} {...HALO}>{w.text}</text>}
              {w.label === 'left' && <text x={cx - 13} y={ty} fontSize={10} textAnchor="end" fill={color} {...HALO}>{w.text}</text>}
            </g>
          )
        })}

        {/* ── Winds aloft: barbs at each standard pressure level's nominal
            altitude, one column every ~20 NM (useWindAloftAlongRoute). Model
            forecast, so drawn dimmer than the station barbs. */}
        {showWindAloft && windAloft.flatMap((col, ci) => col.levels.map((lv) => {
          // Surface (10 m) wind is part of the wind row under the x axis.
          if (lv.surface || lv.altFt > yMax * 0.96) return null
          const edge = Math.min(WIND_ALOFT_EDGE_PX, L.plotW / 2)
          const cx = Math.min(Math.max(L.xOf(col.distNm), L.plotLeft + edge), L.plotRight - edge)
          const cy = L.yOf(lv.altFt)
          const label = lv.speedKts === 0 ? 'CALM' : `${String(lv.dirDeg).padStart(3, '0')}°/${lv.speedKts}`
          return (
            <g key={`windaloft-${ci}-${lv.altFt}`} aria-hidden="true" opacity={0.85}>
              {renderBarbAt(cx, cy, lv.dirDeg, lv.speedKts, lv.speedKts === 0)}
              <text x={cx + 12} y={cy + 3} fontSize={9} fill={windBarbColorForSpeed(lv.speedKts)} {...HALO}>{label}</text>
            </g>
          )
        }))}

        {/* ── Landmarks on the ground, real map pictograms ──────── */}
        {profile.landmarks.map((lmk, i) => {
          // Floored at 0: landmarks have no elevation of their own and
          // terrainAt() can go slightly negative from DEM noise near water.
          const baseFt = Math.max(0, terrainAt(terrainPts, lmk.distNm))
          const cx = L.xOf(lmk.distNm), cy = L.yOf(baseFt)
          return renderIconAt(`lmk-${i}`, cx, cy, 14, iconMarkup[`lmk:${lmk.kind}`],
            <circle cx={cx} cy={cy} r={2.5} fill="rgba(150,150,150,0.9)" stroke="rgba(0,0,0,0.4)" strokeWidth={1} />)
        })}

        {/* ── Waypoint lines + names (collision-filtered above) ─── */}
        {visibleWaypointTicks.map(({ tick, isLast }) => {
          const x = L.xOf(tick.distNm)
          return (
            <g key={`wp-${tick.distNm}-${tick.name}`}>
              <line x1={x} y1={L.plotTop} x2={x} y2={L.plotBottom} stroke="var(--border-default)" />
              <text
                x={isLast ? x - LINE_LABEL_INSET : x + LINE_LABEL_INSET} y={L.plotTop + LINE_LABEL_INSET}
                dominantBaseline="hanging" textAnchor={isLast ? 'end' : 'start'}
                fontSize={10} fill="var(--text-secondary)"
              >
                {tick.name}
              </text>
            </g>
          )
        })}

        {/* ── Ground fill (elevation-banded gradient) + outline ─── */}
        {series.ground && (
          <>
            <path d={groundAreaPath(terrainPts, L.xOf, L.yOf, L.totalNm)} fill="url(#terrainGrad)" />
            <path d={groundOutline} fill="none" stroke={GROUND_COLOR} strokeWidth={1} />
          </>
        )}

        {/* ── Planned altitude line, MSA, below-MSA stretches in red ── */}
        <path d={plannedPath} fill="none" stroke={PLAN_COLOR} strokeWidth={2} />
        {msaPath && <path d={msaPath} fill="none" stroke={MSA_COLOR} strokeWidth={1} strokeDasharray="5 3" />}
        {series.belowMsa.map((run, i) => (
          <path key={`below-${i}`} d={polylinePath(run, L.xOf, L.yOf)} fill="none" stroke={DANGER_COLOR} strokeWidth={2.5} />
        ))}

        {/* ── Axes ──────────────────────────────────────────────── */}
        {renderYAxis(L, yTicks)}
        <line x1={L.plotLeft} y1={L.plotBottom} x2={L.plotRight} y2={L.plotBottom} stroke="var(--border-default)" />
        {xTicks.map((t, i) => windRow.tickLabelShown[i] !== false && (
          <text key={`xl-${t.label}`} x={L.xOf(t.nm)} y={L.plotBottom + 8} dy="0.71em" textAnchor="middle" fontSize={10} fill="var(--text-muted)">
            {t.label}
          </text>
        ))}
        <text x={L.plotRight + 2} y={L.plotBottom + 15} dy="0.355em" textAnchor="end" fontSize={10} fill="var(--text-faint)">
          {distLabel(units.distance)}
        </text>
      </>
    )
  }, [profile, layout, series, yMax, yTicks, xTicks, terrainPts, terrainStops, weatherMarks, windRow, showWindAloft, windAloft, iconMarkup, visibleWaypointTicks, units.distance])

  if (!profile || !series || series.distNms.length === 0) return null

  // ── Live layer (re-rendered every GPS tick) ────────────────────────────────
  const L = layout
  const live = L && (
    <g pointerEvents="none">
      {currentDistNm != null && (
        <line x1={L.xOf(currentDistNm)} y1={L.plotTop} x2={L.xOf(currentDistNm)} y2={L.plotBottom}
          stroke="var(--text-faint)" strokeWidth={1} strokeDasharray="3 3" />
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
      {/* Aircraft silhouette; clamped to the altitude scale so it never leaves the plot. */}
      {currentDistNm != null && currentAltFt != null && (
        <g transform={`translate(${L.xOf(currentDistNm)},${L.yOf(Math.max(0, Math.min(yMax, currentAltFt)))})`} aria-hidden="true">
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
        <span className={css.title}>{title ?? 'VIRTUAL RADAR'}</span>
        <span className={css.totalDist}>
          {nmToDisplay(profile.totalNm, units.distance).toFixed(1)} {distLabel(units.distance)}
        </span>
        {terrainFailed && terrainPts.length === 0 && (
          <span className={css.offTrackBadge} title="No elevation data could be loaded for this route. The MSA line is missing and airspace limits given above ground (AGL) are drawn at their raw height.">
            ⚠ No terrain data: MSA unavailable, AGL limits at raw height
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
          {L?.scrollable && <span className={css.scrollHint}>↔ scroll</span>}
          {L && (
            <div className={css.chartContent} style={{ width: L.contentW, height: CHART_H }}>
              {/* Pinned altitude scale: stuck to the left edge while the chart
                  scrolls, on an opaque panel-coloured backing so scrolled
                  content disappears at the axis instead of scrolling the FL
                  scale away. Only rendered when the chart actually scrolls. */}
              {L.scrollable && (
                <div className={css.yAxisPinned} aria-hidden>
                  <svg width={MARGIN.left} height={CHART_H}>{renderYAxis(L, yTicks)}</svg>
                </div>
              )}
              <svg className={css.chartSvg} width={L.contentW} height={CHART_H} role="img" aria-label="Vertical profile of the route">
                {scene}
                {live}
              </svg>
              <HoverOverlay layout={L} series={series} onHoverDistNm={onHoverDistNm} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Memoised: MapView re-renders every GPS tick, the chart only when its props change.
export default memo(VirtualRadar)
