import { useEffect, useMemo, useState, useRef } from 'react'
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
} from 'recharts'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { LegOverride } from '../db/index'
import { type Units, DEFAULT_UNITS, nmToDisplay, distLabel } from '../utils/units'
import {
  buildVirtualRadarProfile, fetchTerrainProfile, projectFlightPath, computeMsaProfile, terrainAt,
  getMsaLookup, computeTrajectoryTicks, computeVspeedTrajectory, projectWeatherMarks,
  type TerrainPoint, type MsaPoint, type AircraftPerfModel,
} from '@open-vfr/shared/virtualRadarCalc'
import { resolveStationWeather } from '@open-vfr/shared/parseTaf'
import { windBarbColorForSpeed, windArrowStrokeWidth } from '@open-vfr/shared/windBarb'
import type { AircraftProfileDocType } from '../db/index'
import type { RouteWeatherStation } from '../hooks/useWeatherAlongRoute'
import type { WindSample } from '../hooks/useWindAlongRoute'
import css from './VirtualRadar.module.css'
import { TILES_BASE_URL } from '../utils/env'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'
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
  /** Regular-interval wind samples (from useWindAlongRoute), independent of
   *  aerodrome positions -- fills the gaps between weatherStations' arrows,
   *  which only ever exist wherever an aerodrome happens to sit. Rendered
   *  visibly lighter/dashed since these can be model-wind estimates, not
   *  observed reports. Omit to hide entirely. */
  windSamples?: WindSample[]
}

// ---------------------------------------------------------------------------
// Step-function altitude lookup (planned altitude at any distance along route)
// ---------------------------------------------------------------------------
function getPlannedAlt(altProfile: { distNm: number; altFt: number }[], distNm: number): number {
  let alt = altProfile[0]?.altFt ?? 0
  for (const p of altProfile) {
    if (p.distNm <= distNm) alt = p.altFt
    else break
  }
  return alt
}

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
    rows.push({ label, ft: p.value, color: (p.color as string) ?? 'rgba(255,255,255,0.7)' })
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function VirtualRadar({
  waypoints, legOverrides, units = DEFAULT_UNITS, title, onHoverDistNm, aircraftProfile,
  currentDistNm, currentAltFt, currentSpeedKts, currentVSpeedFpm, trajectoryMode, crosshairDistNm,
  crossTrackNm, weatherStations, windSamples,
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
  const [msaPts,     setMsaPts]     = useState<MsaPoint[]>([])
  const [collapsed, setCollapsed]         = useState(false)
  const [showProjection, setShowProjection] = useState(false)
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

  // Load GeoJSON once
  useEffect(() => {
    fetch(versionedTileUrl(TILES_BASE_URL, 'se-airspace.geojson'))
      .then((r) => r.json())
      .then(setAirspaceGeo)
      .catch(() => { /* offline — no airspace bands */ })
    fetch(versionedTileUrl(TILES_BASE_URL, 'se-obstacles.geojson'))
      .then((r) => r.json())
      .then(setObstacleGeo)
      .catch(() => { /* offline — no obstacle markers */ })
    fetch(versionedTileUrl(TILES_BASE_URL, 'se-water.geojson'))
      .then((r) => r.json())
      .then(setWaterGeo)
      .catch(() => { /* offline / not yet generated — no water crossings */ })
    fetch(versionedTileUrl(TILES_BASE_URL, 'se-landmarks.geojson'))
      .then((r) => r.json())
      .then(setLandmarkGeo)
      .catch(() => { /* offline — no landmark markers */ })
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
    setTerrainPts([])  // clear stale terrain while new fetch is in progress
    fetchTerrainProfile(waypoints, '', controller.signal)
      .then((pts) => {
        setTerrainPts(pts)
        setMsaPts(computeMsaProfile(pts))
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') {
          console.warn('Terrain fetch failed:', err)
        }
      })
    return () => controller.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey])

  const profile = useMemo(() => {
    if (waypoints.length < 2 || !airspaceGeo || !obstacleGeo) return null
    return buildVirtualRadarProfile(
      waypoints,
      legOverrides,
      airspaceGeo,
      obstacleGeo,
      waterGeo ?? undefined,
      landmarkGeo ?? undefined,
    )
  }, [waypoints, legOverrides, airspaceGeo, obstacleGeo, waterGeo, landmarkGeo])

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
                                               'rgba(255,255,255,0.55)'
  const VSPEED_DANGER_COLOR = 'rgba(239,68,68,0.95)'

  // Weather stations projected onto the route's distance axis — same shared
  // projection native uses for its wind-arrow/cloud-layer overlay.
  // TAF only fills in wind/clouds when a station has no current METAR (see
  // resolveStationWeather / parseTaf.ts header for the full scope note —
  // this is NOT a route-position-vs-forecast-time overlay, that needs an
  // ETD field this app doesn't have). tafChangeSoon flags a real trend
  // change (FM/BECMG) in the next 3h — a nudge to go check the bulletin
  // rather than a rendered forecast. Mirrors native's identical change.
  const weatherMarks = useMemo(() => {
    if (!weatherStations || !profile) return []
    return projectWeatherMarks(waypoints, weatherStations, profile.totalNm).map((m) => {
      const resolved = resolveStationWeather({
        metarWind: m.station.decoded?.wind ?? null,
        metarClouds: m.station.decoded?.clouds ?? null,
        taf: m.station.taf,
      })
      return { distNm: m.distNm, wind: resolved.wind, clouds: resolved.clouds, tafChangeSoon: resolved.tafChangeSoon }
    })
  }, [weatherStations, waypoints, profile])

  // Regular-interval wind samples, filtered against weatherMarks above so a
  // sample doesn't draw a second, visibly-different (dashed/model) arrow
  // right next to a real station's arrow that already covers roughly the
  // same stretch of route. MIN_SAMPLE_SEPARATION_NM is deliberately smaller
  // than useWindAlongRoute's own SAMPLE_INTERVAL_NM spacing -- it only needs
  // to suppress the specific case of a sample landing very close to an
  // existing real marker, not to re-implement that spacing itself.
  const MIN_SAMPLE_SEPARATION_NM = 5
  const visibleWindSamples = useMemo(() => {
    if (!windSamples || windSamples.length === 0) return []
    const markDists = weatherMarks.filter((m) => m.wind).map((m) => m.distNm)
    return windSamples.filter((s) => !markDists.some((d) => Math.abs(d - s.distNm) < MIN_SAMPLE_SEPARATION_NM))
  }, [windSamples, weatherMarks])

  // Measure the chart wrap's width — needed to decide whether the route is
  // wider than the panel (MIN_PX_PER_NM) and therefore should scroll instead
  // of Recharts' ResponsiveContainer squeezing the whole route into 100%.
  useEffect(() => {
    const el = chartWrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w != null) setWrapW(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

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
      const SUPPRESS_NM = 5
      const lastIdx = terrainPts.length - 1

      // First pass: compute per-point values and belowMsa flag.
      const raw = terrainPts.map(({ distNm, elevFt }, i) => {
        const proj = projAlts ? projAlts[i] : undefined
        const msa  = getMsa(distNm)
        const nearEndpoint = distNm < SUPPRESS_NM || (profile.totalNm - distNm) < SUPPRESS_NM
        const belowMsa = proj != null && msa > 0 && proj < msa && !nearEndpoint
        const plannedAlt = i === 0      ? depElevFt
                         : i === lastIdx ? arrElevFt
                         : getPlannedAlt(profile.altitudeProfile, distNm)
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
  const plotRightPx = contentPxWidth - 12

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
    let lastX = -Infinity
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
          <ResponsiveContainer width="100%" height={180}>
            <ComposedChart
              data={chartData}
              // top bumped 8->26px (chartWrap grew by the same 20px, see
              // VirtualRadar.module.css) to reserve real headroom above the
              // plot for wind arrows, which previously sat inside the plot's
              // own top strip fighting waypoint-name labels for the same
              // few pixels -- see the wind-arrow y comment below.
              margin={{ top: 26, right: 12, bottom: 2, left: 4 }}
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
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />

              <XAxis
                dataKey="dist"
                type="number"
                domain={[0, Math.ceil(nmToDisplay(profile.totalNm, units.distance))]}
                tickCount={8}
                tickFormatter={(v: number) => `${v.toFixed(0)}`}
                tick={{ fill: 'rgba(255,255,255,0.45)', fontSize: 9 }}
                tickLine={false}
                axisLine={{ stroke: 'rgba(255,255,255,0.15)' }}
                label={{ value: distLabel(units.distance), position: 'insideRight', offset: -2, fill: 'rgba(255,255,255,0.3)', fontSize: 9 }}
              />

              <YAxis
                domain={[0, yMax]}
                tickCount={5}
                tickFormatter={(v: number) => v >= 1000 ? `FL${Math.round(v / 100).toString().padStart(3,'0')}` : `${v}`}
                tick={{ fill: 'rgba(255,255,255,0.45)', fontSize: 9 }}
                tickLine={false}
                axisLine={{ stroke: 'rgba(255,255,255,0.15)' }}
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
              {profile.airspaceBands.map((band, i) => (
                <ReferenceArea
                  key={i}
                  x1={nmToDisplay(band.entryNm, units.distance)}
                  x2={nmToDisplay(band.exitNm,  units.distance)}
                  y1={band.lower_ft}
                  y2={band.upper_ft}
                  fill={band.fill}
                  stroke={band.border}
                  strokeWidth={1}
                />
              ))}

              {/* Weather: cloud-base layers — translucent
                  bands from each METAR cloud groups base up to the top of
                  the plot; opacity increases FEW/SCT/BKN/OVC so a ceiling
                  reads visibly denser than scattered cloud. Drawn as a
                  fixed-width band straddling the station (a point
                  observation) rather than interpolated between stations
                  miles apart, which would imply false precision — same
                  reasoning/rendering as natives identical overlay. */}
              {weatherMarks.map((m, i) => {
                const halfWidthNm = Math.min(profile!.totalNm * 0.06, 4)
                const x1 = nmToDisplay(Math.max(0, m.distNm - halfWidthNm), units.distance)
                const x2 = nmToDisplay(Math.min(profile!.totalNm, m.distNm + halfWidthNm), units.distance)
                const cloudOpacity: Record<string, number> = { FEW: 0.10, SCT: 0.18, BKN: 0.30, OVC: 0.42 }
                return m.clouds.map((c, j) => (
                  <ReferenceArea
                    key={`cloud-${i}-${j}`}
                    x1={x1} x2={x2} y1={c.baseFt} y2={yMax}
                    fill={`rgba(205,215,230,${cloudOpacity[c.cover]})`}
                    stroke="none"
                  />
                ))
              })}

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

              {/* Weather: wind arrows — one per station near the top
                  margin, rotated to point the direction the wind is blowing
                  TOWARD (METAR wind direction is FROM, hence +180) — same
                  convention as native and the main map. Length/opacity scale
                  with speed; calm/variable draw a small ring instead of a
                  directional arrow, since there is no single direction to
                  show. Rendered via ReferenceDots custom shape callback,
                  the same technique already used above for obstacle/landmark
                  markers and below for the aircraft silhouette. */}
              {weatherMarks.map((m, i) => {
                if (!m.wind) return null
                // Clamp inward from both chart edges — a station near the
                // route's start/end otherwise lands the arrow (and its
                // dirDeg/speed label) right on top of the y-axis line and
                // FL tick labels, or off the right edge past the last NM
                // tick. Margin is in the same display-distance units as the
                // x-axis domain, derived from the actual px-per-unit scale
                // (contentPxWidth/totalNmDisplay, from the scroll-width calc
                // above) so it stays a constant ~24px regardless of route
                // length/zoom, not a fixed NM offset that shrinks to nothing
                // on a long route or overshoots on a short one.
                const pxPerUnit = totalNmDisplay > 0 ? contentPxWidth / totalNmDisplay : 0
                const edgeMargin = Math.min(pxPerUnit > 0 ? 24 / pxPerUnit : 0, totalNmDisplay / 2)
                const xRaw = nmToDisplay(m.distNm, units.distance)
                const x = Math.min(Math.max(xRaw, edgeMargin), totalNmDisplay - edgeMargin)
                // Above the y-domain (not just near its top) so the arrow
                // lands in the reserved top margin (margin.top=26, see
                // ComposedChart above) instead of the plot's own top strip,
                // where waypoint-name ReferenceLine labels also live --
                // requires ifOverflow="visible" since y > yMax is otherwise
                // clipped to the plot bounds.
                const y = yMax * 1.1
                return (
                  <ReferenceDot
                    key={`wind-${i}`}
                    x={x} y={y} r={0} fill="transparent" stroke="none" ifOverflow="visible"
                    shape={(dotProps) => {
                      const { cx = 0, cy = 0 } = dotProps as { cx?: number; cy?: number }
                      // Dir/speed text drawn to the RIGHT of the arrow (not
                      // below it, and outside the rotated arrow group so the
                      // text itself never rotates) -- only when it fits
                      // before the plot's right edge, using a rough
                      // char-width*fontSize estimate rather than measuring
                      // real text width, same fixed-budget tradeoff already
                      // used elsewhere in this chart (e.g. MIN_WP_LABEL_GAP_PX).
                      // Skipped entirely (not wrapped/shrunk) when it doesn't
                      // fit, since a station near the route's end otherwise
                      // has nowhere else uncluttered to put it.
                      const fontSize = 7
                      const renderLabel = (text: string, halfW: number) => {
                        if (!text) return null
                        const labelW = text.length * fontSize * 0.62
                        if (cx + halfW + 4 + labelW > plotRightPx) return null
                        return <text x={cx + halfW + 4} y={cy + fontSize * 0.35} fontSize={fontSize} fill="rgba(148,197,255,0.85)">{text}</text>
                      }
                      if (m.wind!.calm) {
                        return (
                          <g aria-hidden="true">
                            <circle cx={cx} cy={cy} r={3} fill="none" stroke="rgba(148,163,184,0.7)" strokeWidth={1} />
                            {renderLabel('CALM', 3)}
                          </g>
                        )
                      }
                      if (m.wind!.dirDeg == null) {
                        return <circle cx={cx} cy={cy} r={3} fill="none" stroke="rgba(250,204,21,0.7)" strokeWidth={1} strokeDasharray="1.5,1.5" />
                      }
                      const len = Math.min(18, 6 + m.wind!.speedKt * 0.5)
                      const rot = m.wind!.dirDeg + 180
                      // Speed-tiered colour + thickness (see @open-vfr/shared/windBarb) --
                      // arrows get visibly bolder/brighter with wind strength, not just
                      // longer, so strength reads at a glance without needing the
                      // numeric label beside it.
                      const strokeW = windArrowStrokeWidth(m.wind!.speedKt)
                      const color = windBarbColorForSpeed(m.wind!.speedKt)
                      return (
                        <g aria-hidden="true">
                          <g transform={`translate(${cx},${cy}) rotate(${rot})`}>
                            <line x1={0} y1={-len / 2} x2={0} y2={len / 2} stroke={color} strokeWidth={strokeW} strokeLinecap="round" />
                            <path d={`M0,${len / 2} L-2.5,${len / 2 - 4} L2.5,${len / 2 - 4} Z`} fill={color} />
                          </g>
                          {renderLabel(`${m.wind!.dirDeg}°/${m.wind!.speedKt}`, len / 2)}
                        </g>
                      )
                    }}
                  />
                )
              })}

              {/* Weather: regular-interval wind samples (useWindAlongRoute)
                  — fills the gaps between real-station arrows above, which
                  only ever exist wherever an aerodrome happens to sit.
                  Deliberately drawn thinner/dashed/dimmer than a real
                  station's arrow so a model-wind estimate (or a distant
                  METAR borrowed via fetchWxResolvedForPoint) is never
                  mistaken for an actual local observation. Already filtered
                  against weatherMarks in visibleWindSamples above. */}
              {visibleWindSamples.map((s, i) => {
                const pxPerUnit = totalNmDisplay > 0 ? contentPxWidth / totalNmDisplay : 0
                const edgeMargin = Math.min(pxPerUnit > 0 ? 24 / pxPerUnit : 0, totalNmDisplay / 2)
                const xRaw = nmToDisplay(s.distNm, units.distance)
                const x = Math.min(Math.max(xRaw, edgeMargin), totalNmDisplay - edgeMargin)
                const y = yMax * 1.1 // reserved top margin, same as the real wind-arrow block above
                return (
                  <ReferenceDot
                    key={`windsample-${i}`}
                    x={x} y={y} r={0} fill="transparent" stroke="none" ifOverflow="visible"
                    shape={(dotProps) => {
                      const { cx = 0, cy = 0 } = dotProps as { cx?: number; cy?: number }
                      // Same right-of-arrow, skip-if-no-room text placement
                      // as the real wind-arrow block above.
                      const fontSize = 6
                      const renderLabel = (text: string, halfW: number) => {
                        if (!text) return null
                        const labelW = text.length * fontSize * 0.62
                        if (cx + halfW + 4 + labelW > plotRightPx) return null
                        return <text x={cx + halfW + 4} y={cy + fontSize * 0.35} fontSize={fontSize} fill="rgba(148,197,255,0.5)">{text}</text>
                      }
                      if (s.wind.calm) {
                        return (
                          <g aria-hidden="true">
                            <circle cx={cx} cy={cy} r={2.5} fill="none" stroke="rgba(148,163,184,0.4)" strokeWidth={1} strokeDasharray="1.5,1.5" />
                            {renderLabel('~CALM', 2.5)}
                          </g>
                        )
                      }
                      if (s.wind.dirDeg == null) return <g />
                      const len = Math.min(14, 5 + s.wind.speedKt * 0.4)
                      const rot = s.wind.dirDeg + 180
                      // Same speed-tiered colour as a real station's arrow,
                      // just at reduced opacity -- keeps the strength read
                      // consistent while still visibly distinct from a real
                      // observation.
                      const strokeW = Math.max(1, windArrowStrokeWidth(s.wind.speedKt) - 0.5)
                      const color = windBarbColorForSpeed(s.wind.speedKt)
                      return (
                        <g aria-hidden="true">
                          <g transform={`translate(${cx},${cy}) rotate(${rot})`} opacity={0.55}>
                            <line x1={0} y1={-len / 2} x2={0} y2={len / 2} stroke={color} strokeWidth={strokeW} strokeLinecap="round" strokeDasharray="3,2" />
                            <path d={`M0,${len / 2} L-2,${len / 2 - 3} L2,${len / 2 - 3} Z`} fill={color} />
                          </g>
                          {renderLabel(`~${s.wind.dirDeg}°/${s.wind.speedKt}`, len / 2)}
                        </g>
                      )
                    }}
                  />
                )
              })}

              {/* TAF "check the bulletin" warning — small yellow triangle
                  when a real trend change (FM/BECMG) lands within the next
                  3h (see resolveStationWeather/parseTaf.ts). Not a rendered
                  forecast column — just a nudge to go read the TAF text.
                  Mirrors native's identical marker. */}
              {weatherMarks.map((m, i) => m.tafChangeSoon ? (
                <ReferenceDot
                  key={`tafwarn-${i}`}
                  x={nmToDisplay(m.distNm, units.distance)}
                  y={yMax * 0.90}
                  r={0} fill="transparent" stroke="none"
                  ifOverflow="visible"
                  shape={(dotProps) => {
                    const { cx = 0, cy = 0 } = dotProps as { cx?: number; cy?: number }
                    return (
                      <path
                        transform={`translate(${cx},${cy})`}
                        d="M0,-5 L4.5,4 L-4.5,4 Z"
                        fill="rgba(250,204,21,0.9)" stroke="rgba(0,0,0,0.4)" strokeWidth={0.5}
                      />
                    )
                  }}
                />
              ) : null)}

              {/* ── Landmark markers, floored at terrain, real map pictograms
                  Same lmk-*.svg icons (recoloured via LANDMARK_ICON_DEFS) the
                  main map and native's VerticalProfile both use — this used
                  to render a generic dot glyph instead of the actual symbols. */}
              {profile.landmarks.map((lmk, i) => {
                const baseFt = terrainAt(terrainPts, lmk.distNm)
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
                  stroke="rgba(255,255,255,0.18)"
                  strokeWidth={1}
                  label={{
                    value: tick.name,
                    position: tick === profile!.waypointTicks[profile!.waypointTicks.length - 1] ? 'insideTopRight' : 'insideTopLeft',
                    fill: 'rgba(255,255,255,0.50)',
                    fontSize: 8,
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
                  stroke="rgba(255,255,255,0.40)"
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
                          <path key={`ac-part-${i}`} d={part.d} fill="white" opacity={part.opacity} />
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
                    fontSize: 8,
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
