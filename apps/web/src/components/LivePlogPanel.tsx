/**
 * LivePlogPanel — in-flight pilot log overlay.
 *
 * Shows the route table with live ETA / ATA columns, a green progress bar on
 * the current leg, upcoming communication frequencies (10-min lookahead), and
 * nearby VOR/NDB nav aid frequencies.
 *
 * Positioned above the GoFlyingPanel, anchored to the left side of the map.
 */

import type { RouteWaypoint } from '../utils/routeCalc'
import type { LivePlogData } from '../hooks/useLivePlog'
import css from './LivePlogPanel.module.css'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtUtcTime(d: Date): string {
  return `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}z`
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  waypoints:      RouteWaypoint[]
  activeWpIdx:    number
  plogData:       LivePlogData
  onClose:        () => void
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function LivePlogPanel({ waypoints, activeWpIdx, plogData, onClose }: Props) {
  const { atas, liveEtas, legProgressPct, upcomingFreqs, nearbyNavaids } = plogData

  if (waypoints.length < 2) return null

  return (
    <div className={css.panel}>
      {/* Header */}
      <div className={css.header}>
        <span className={css.title}>PILOT LOG</span>
        <button className={css.closeBtn} onClick={onClose} title="Close pilot log">✕</button>
      </div>

      {/* Route table */}
      <div className={css.tableWrap}>
        <div className={css.tableHead}>
          <span className={css.colWp}>Waypoint</span>
          <span className={css.colAta}>ATA</span>
          <span className={css.colEta}>ETA</span>
        </div>

        <div className={css.tableBody}>
          {waypoints.map((wp, i) => {
            const isPast    = i > 0 && i < activeWpIdx
            const isCurrent = i === activeWpIdx
            const isDep     = i === 0
            const ata       = atas[i]
            const eta       = liveEtas[i]

            return (
              <div
                key={i}
                className={`${css.row}${isPast ? ` ${css.rowPast}` : ''}${isCurrent ? ` ${css.rowCurrent}` : ''}${isDep ? ` ${css.rowDep}` : ''}`}
                style={isCurrent && legProgressPct != null
                  ? { '--plog-progress': `${legProgressPct}%` } as React.CSSProperties
                  : undefined}
              >
                <div className={css.progressBar} />
                <span className={css.colWp}>
                  {wp.name ?? `WP${i + 1}`}
                  {wp.note && <span className={css.noteFlag} title={wp.note}>📍</span>}
                </span>
                <span className={`${css.colAta}${ata ? ` ${css.ataActual}` : ''}`}>
                  {ata ? fmtUtcTime(ata) : '——'}
                </span>
                <span className={`${css.colEta}${isCurrent ? ` ${css.etaCurrent}` : ''}`}>
                  {eta ? fmtUtcTime(eta) : '——'}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Upcoming comms */}
      {upcomingFreqs.length > 0 && (
        <div className={css.freqSection}>
          <div className={css.freqHeader}>COMMS AHEAD</div>
          {upcomingFreqs.map((f, i) => (
            <div key={i} className={css.freqRow}>
              <span className={css.freqIcao}>{f.icao}</span>
              <span className={css.freqService}>{f.service}</span>
              <span className={css.freqValue}>{f.freq}</span>
              <span className={css.freqDist}>{f.distNm} NM</span>
            </div>
          ))}
        </div>
      )}

      {/* Nearby navaids */}
      {nearbyNavaids.length > 0 && (
        <div className={css.freqSection}>
          <div className={css.freqHeader}>NAV AIDS</div>
          {nearbyNavaids.map((n, i) => (
            <div key={i} className={css.freqRow}>
              <span className={css.freqIcao}>{n.id}</span>
              <span className={css.freqService}>{n.type}</span>
              <span className={css.freqValue}>{n.freq}</span>
              <span className={css.freqDist}>{n.distNm} NM</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
