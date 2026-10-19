import { useEffect, useState } from 'react'
import { computeLogStats, formatLogDuration, type LogStats } from '@open-vfr/shared/flightLogStats'
import { getDb, type FlightLogDocType, type TrackPoint } from '../db'
import css from './FlightLogs.module.css'

interface Props {
  selectedLogId: string | null
  onSelect: (id: string) => void
  onClear: () => void
}

function fmt(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// Default takeoff/landed speeds; the aircraft profile's own thresholds are not
// known per log, and the list only needs a good approximation.
const STATS_THR = { takeoffKts: 30, landedKts: 20 }

function statsFor(log: FlightLogDocType): LogStats | null {
  try {
    return computeLogStats(JSON.parse(log.trackJson || '[]') as TrackPoint[], STATS_THR)
  } catch { return null }
}

function landingsLabel(st: LogStats): string {
  const base = `${st.landings} landing${st.landings === 1 ? '' : 's'}`
  return st.touchAndGos > 0 ? `${base} (${st.touchAndGos} T&G)` : base
}

export default function FlightLogs({ selectedLogId, onSelect, onClear }: Props) {
  const [logs, setLogs] = useState<{ doc: FlightLogDocType; stats: LogStats | null }[]>([])
  const [deleteId, setDeleteId] = useState<string | null>(null)

  async function handleDelete(id: string) {
    const db = await getDb()
    const doc = await db.flight_logs.findOne(id).exec()
    await doc?.remove()
    setDeleteId(null)
    if (id === selectedLogId) onClear()
  }

  useEffect(() => {
    let sub: { unsubscribe(): void } | null = null
    getDb().then(db => {
      sub = db.flight_logs
        .find({ selector: { endedAt: { $gt: 0 } } })
        .$.subscribe(docs => {
          const sorted = [...docs].sort((a, b) => b.startedAt - a.startedAt)
          setLogs(sorted.map(d => { const doc = d.toJSON(); return { doc, stats: statsFor(doc) } }))
        })
    })
    return () => sub?.unsubscribe()
  }, [])

  if (logs.length === 0) {
    return (
      <div className={css.panel}>
        <p className={css.empty}>No completed flights recorded yet.</p>
      </div>
    )
  }

  return (
    <div className={css.panel}>
      {selectedLogId && (
        <div className={css.clearRow}>
          <button className={css.clearBtn} onClick={onClear}>Clear track</button>
        </div>
      )}
      <div className={css.list}>
        {logs.map(({ doc: log, stats }) => {
          const isActive = log.id === selectedLogId
          const depArr = [log.departureIcao, log.arrivalIcao]
            .filter(Boolean).join(' → ') || 'Unknown route'
          return (
            <div key={log.id} className={`${css.item} ${isActive ? css.itemActive : ''}`}>
              <div className={css.itemInfo}>
                <span className={css.itemTitle}>{depArr}</span>
                <div className={css.itemMeta}>
                  <span className={css.itemMetaVal}>{fmt(log.startedAt)}</span>
                  <span className={css.itemMetaVal}>{log.distanceNm.toFixed(1)} NM</span>
                  <span className={css.itemMetaVal}>
                    {formatLogDuration(stats && stats.airborneMs > 0 ? stats.airborneMs : log.endedAt - log.startedAt)}
                  </span>
                  {stats && stats.landings > 0 && <span className={css.itemMetaVal}>{landingsLabel(stats)}</span>}
                  {log.maxAltFt > 0 && <span className={css.itemMetaVal}>max {Math.round(log.maxAltFt).toLocaleString()} ft</span>}
                  {stats && stats.gapCount > 0 && <span className={css.itemMetaVal} title="GPS track has gaps">⚠ gaps</span>}
                </div>
              </div>
              <div className={css.itemActions}>
                {deleteId === log.id ? (
                  <>
                    <button className={`${css.viewBtn} ${css.viewBtnDanger}`} onClick={() => handleDelete(log.id)} title="Confirm delete">✓</button>
                    <button className={css.viewBtn} onClick={() => setDeleteId(null)} title="Cancel">✕</button>
                  </>
                ) : (
                  <>
                    <button
                      className={`${css.viewBtn} ${isActive ? css.viewBtnActive : ''}`}
                      onClick={() => isActive ? onClear() : onSelect(log.id)}
                    >
                      {isActive ? 'Hide' : 'View'}
                    </button>
                    <button className={`${css.viewBtn} ${css.viewBtnDanger}`} title="Delete" onClick={() => setDeleteId(log.id)}>✕</button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
