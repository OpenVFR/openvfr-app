/**
 * LiveTrackChart — real-time altitude + ground speed profile for the current flight.
 *
 * Shown in the VirtualRadar row when flying without a planned route.
 * X-axis: cumulative distance flown (NM).
 * Primary line (green): altitude in ft.
 * Secondary line (cyan): ground speed in kts.
 */

import { useMemo, useState } from 'react'
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import type { TrackPoint } from '../db/index'
import css from './VirtualRadar.module.css'   // reuse same dark panel styles
import selfCss from './LiveTrackChart.module.css'

// ── Helpers ────────────────────────────────────────────────────────────────
const NM_PER_DEG_LAT = 60.0

function quickDistNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * NM_PER_DEG_LAT
  const dLng = (lng2 - lng1) * NM_PER_DEG_LAT * Math.cos((lat1 + lat2) * 0.5 * Math.PI / 180)
  return Math.sqrt(dLat * dLat + dLng * dLng)
}

// ── Types ──────────────────────────────────────────────────────────────────
interface Props {
  track: TrackPoint[]
  onHoverDistNm?: (nm: number | null) => void
}

interface ChartPoint {
  distNm: number
  altFt:  number
  spdKts: number
}

// ── Custom Tooltip ─────────────────────────────────────────────────────────
function TrackTooltip({ active, payload }: { active?: boolean; payload?: { name: string; value: number }[] }) {
  if (!active || !payload?.length) return null
  const alt = payload.find(p => p.name === 'altFt')?.value
  const spd = payload.find(p => p.name === 'spdKts')?.value
  return (
    <div className={css.tooltip}>
      {alt != null && <div>{Math.round(alt)} ft</div>}
      {spd != null && <div className={selfCss.tooltipSpd}>{Math.round(spd)} kts</div>}
    </div>
  )
}

// ── Component ──────────────────────────────────────────────────────────────
export default function LiveTrackChart({ track, onHoverDistNm }: Props) {
  const [collapsed, setCollapsed] = useState(false)

  const data = useMemo((): ChartPoint[] => {
    if (track.length === 0) return []
    const pts: ChartPoint[] = []
    let cumDist = 0
    for (let i = 0; i < track.length; i++) {
      if (i > 0) {
        cumDist += quickDistNm(track[i-1].lat, track[i-1].lng, track[i].lat, track[i].lng)
      }
      pts.push({
        distNm: Math.round(cumDist * 10) / 10,
        altFt:  Math.round(track[i].altFt),
        spdKts: Math.round(track[i].spdKts),
      })
    }
    return pts
  }, [track])

  const maxAlt = useMemo(() => Math.max(200, ...data.map(d => d.altFt)), [data])
  const totalDist = data.length > 0 ? data[data.length - 1].distNm : 0

  return (
    <div className={`${css.panel} ${collapsed ? css.collapsed : ''}`}>
      <div className={css.header}>
        <span className={css.title}>LIVE TRACK</span>
        <span className={css.totalDist}>
          {track.length === 0 ? 'awaiting takeoff' : `${totalDist.toFixed(1)} NM`}
        </span>
        <span className={selfCss.maxAltLabel}>
          {track.length > 0 ? `${Math.round(maxAlt).toLocaleString()} ft max` : ''}
        </span>
        <button className={css.collapseBtn} onClick={() => setCollapsed(c => !c)}>
          {collapsed ? '▲' : '▼'}
        </button>
      </div>

      {!collapsed && (
        <div className={css.chartWrap}>
          {data.length < 2 ? (
            <div className={selfCss.empty}>
              Track recording starts on takeoff (GS ≥ 30 kts)
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={100}>
              <ComposedChart
                data={data}
                margin={{ top: 4, right: 16, bottom: 0, left: 0 }}
                onMouseMove={(state: unknown) => {
                  const s = state as { activePayload?: { payload: ChartPoint }[] }
                  if (onHoverDistNm && s.activePayload?.[0]) {
                    onHoverDistNm(s.activePayload[0].payload.distNm)
                  }
                }}
                onMouseLeave={() => onHoverDistNm?.(null)}
              >
                <CartesianGrid strokeDasharray="2 4" stroke="var(--border-subtle)" />
                <XAxis
                  dataKey="distNm"
                  type="number"
                  domain={[0, 'dataMax']}
                  tickFormatter={v => `${v}`}
                  tick={{ fill: 'var(--text-faint)', fontSize: 9 }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  yAxisId="alt"
                  domain={[0, Math.ceil(maxAlt / 500) * 500]}
                  tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : `${v}`}
                  tick={{ fill: 'var(--text-faint)', fontSize: 9 }}
                  tickLine={false}
                  axisLine={false}
                  width={32}
                />
                <YAxis
                  yAxisId="spd"
                  orientation="right"
                  domain={[0, 'dataMax + 20']}
                  tickFormatter={v => `${v}`}
                  tick={{ fill: '#22d3ee', fontSize: 9, opacity: 0.6 }}
                  tickLine={false}
                  axisLine={false}
                  width={28}
                />
                <Tooltip content={<TrackTooltip />} />
                <Line
                  yAxisId="alt"
                  type="monotone"
                  dataKey="altFt"
                  name="altFt"
                  stroke="#4ade80"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="spd"
                  type="monotone"
                  dataKey="spdKts"
                  name="spdKts"
                  stroke="#22d3ee"
                  strokeWidth={1}
                  strokeDasharray="3 2"
                  dot={false}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
    </div>
  )
}
