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
import { buildVirtualRadarProfile, fetchTerrainProfile, projectFlightPath, computeMsaProfile, terrainAt, type TerrainPoint, type MsaPoint, type AircraftPerfModel } from '@open-vfr/shared/virtualRadarCalc'
import type { AircraftProfileDocType } from '../db/index'
import css from './VirtualRadar.module.css'
import { TILES_BASE_URL } from '../utils/env'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'

// ---------------------------------------------------------------------------
// Landmark kind → display colour (mirrors src/utils/landmarkIcons.ts tints)
// ---------------------------------------------------------------------------
const LANDMARK_COLOURS: Record<string, string> = {
  church:       '#455a64',
  mast:         '#e65100',
  windmill:     '#5d4037',
  water_tower:  '#00695c',
  chimney:      '#bf360c',
}

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
  /** Matches the map trajectory mode: 'time' = marks at 1/3/5 min ahead, 'dist' = 1/3/5 NM ahead */
  trajectoryMode?: 'time' | 'dist'
  /** NM along the route for a map-driven crosshair cursor (null = hidden) */
  crosshairDistNm?: number | null
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

export default function VirtualRadar({ waypoints, legOverrides, units = DEFAULT_UNITS, title, onHoverDistNm, aircraftProfile, currentDistNm, currentAltFt, currentSpeedKts, trajectoryMode, crosshairDistNm }: Props) {
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

  // MSA lookup at a given distNm
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

  // Trajectory tick distances (NM along route) — mirrors the map trajectory line marks.
  // Only computed when we have a live position and a meaningful speed (>= 5 kts).
  const trajectoryTickNms = useMemo((): number[] => {
    if (currentDistNm == null || (currentSpeedKts ?? 0) < 5 || !profile) return []
    const totalNm = profile.totalNm
    const marks = trajectoryMode === 'time'
      ? [1, 3, 5].map(min => currentDistNm + (min / 60) * currentSpeedKts!)
      : [1, 3, 5].map(nm  => currentDistNm + nm)
    return marks.filter(d => d <= totalNm)
  }, [currentDistNm, currentSpeedKts, trajectoryMode, profile])

  const trajectoryTickLabels = trajectoryMode === 'time'
    ? ['1m', '3m', '5m']
    : ['1nm', '3nm', '5nm']

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

  if (!profile || chartData.length === 0) return null

  return (
    <div className={`${css.panel} ${collapsed ? css.collapsed : ''}`}>
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className={css.header}>
        <span className={css.title}>{title ?? 'VIRTUAL RADAR'}</span>
        <span className={css.totalDist}>
          {nmToDisplay(profile.totalNm, units.distance).toFixed(1)} {distLabel(units.distance)}
        </span>
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
        <div className={css.chartWrap}>
          <ResponsiveContainer width="100%" height={160}>
            <ComposedChart
              data={chartData}
              margin={{ top: 8, right: 12, bottom: 2, left: 4 }}
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

              {/* ── Obstacle markers at tip elevation ──────────────── */}
              {profile.obstacles.map((obs, i) => {
                const baseFt = Math.max(obs.elevationFt, terrainAt(terrainPts, obs.distNm))
                const tipFt = obs.heightM > 0
                  ? Math.round(baseFt + obs.heightM * 3.28084)
                  : baseFt
                const isWind = obs.kind === 'wind_turbine'
                const colour = isWind ? 'rgba(251,191,36,0.95)' : 'rgba(220,80,60,0.95)'
                return (
                  <ReferenceDot
                    key={`obs-${i}`}
                    x={nmToDisplay(obs.distNm, units.distance)}
                    y={tipFt}
                    r={3}
                    fill={colour}
                    stroke="rgba(0,0,0,0.4)"
                    strokeWidth={1}
                    label={{
                      value: isWind ? '\u25b2' : '\u2b1b',
                      position: 'top',
                      fill: colour,
                      fontSize: 8,
                    }}
                  />
                )
              })}

              {/* ── Landmark markers, floored at terrain ─────────────── */}
              {profile.landmarks.map((lmk, i) => {
                const baseFt = terrainAt(terrainPts, lmk.distNm)
                const colour = LANDMARK_COLOURS[lmk.kind] ?? 'rgba(150,150,150,0.9)'
                return (
                  <ReferenceDot
                    key={`lmk-${i}`}
                    x={nmToDisplay(lmk.distNm, units.distance)}
                    y={baseFt}
                    r={2.5}
                    fill={colour}
                    stroke="rgba(0,0,0,0.4)"
                    strokeWidth={1}
                    label={{
                      value: '\u25cf',
                      position: 'top',
                      fill: colour,
                      fontSize: 7,
                    }}
                  />
                )
              })}

              {/* ── Waypoint ticks ─────────────────────────────────── */}
              {/* Skip the departure tick (i=0) — it sits on the Y-axis and
                  the label overlaps the FL scale. The departure name is
                  implicit (leftmost edge of the chart). */}
              {profile.waypointTicks.map((tick, i) => i === 0 ? null : (
                <ReferenceLine
                  key={`wp-${i}`}
                  x={nmToDisplay(tick.distNm, units.distance)}
                  stroke="rgba(255,255,255,0.18)"
                  strokeWidth={1}
                  label={{
                    value: tick.name,
                    position: i === profile.waypointTicks.length - 1 ? 'insideTopRight' : 'insideTopLeft',
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
                        {/* Fuselage: nose right, tail left */}
                        <path
                          d="M12,0 C8,-2 0,-2.5 -8,-1.5 L-12,-0.5 L-12,1 L-8,2 C0,2.5 8,2 12,0Z"
                          fill="white" opacity="0.95"
                        />
                        {/* Main wing: low-wing, swept back, extends below */}
                        <path
                          d="M0,2 L5,2 L9,10 L7,10Z"
                          fill="white" opacity="0.95"
                        />
                        {/* Vertical stabiliser: extends up at tail */}
                        <path
                          d="M-10,-1.5 L-8,-1.5 L-7,-7 L-9,-7 L-12,-0.5Z"
                          fill="white" opacity="0.90"
                        />
                        {/* Horizontal stabiliser: small, hangs below at tail */}
                        <path
                          d="M-12,0.5 L-9,1.5 L-8,5 L-10,5Z"
                          fill="white" opacity="0.85"
                        />
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
      )}
    </div>
  )
}
