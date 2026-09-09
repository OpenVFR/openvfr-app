import { useEffect, useState } from 'react'
import { getDb, type FlightLogDocType } from '../db'
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

function duration(startMs: number, endMs: number): string {
  const s = Math.round((endMs - startMs) / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export default function FlightLogs({ selectedLogId, onSelect, onClear }: Props) {
  const [logs, setLogs] = useState<FlightLogDocType[]>([])
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
          setLogs(sorted.map(d => d.toJSON()))
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
        {logs.map(log => {
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
                  <span className={css.itemMetaVal}>{duration(log.startedAt, log.endedAt)}</span>
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
