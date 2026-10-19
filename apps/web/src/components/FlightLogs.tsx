import { useEffect, useMemo, useRef, useState } from 'react'
import { flightLogToGpx, gpxToFlightLog } from '@open-vfr/shared/gpx'
import {
  computeLogStats, formatLogDuration, logTotals, logPeriodStart, LOG_PERIODS, LOG_PERIOD_LABEL,
  type LogStats, type LogPeriod,
} from '@open-vfr/shared/flightLogStats'
import { getDb, type FlightLogDocType, type TrackPoint } from '../db'
import css from './FlightLogs.module.css'

interface Props {
  selectedLogId: string | null
  onSelect: (id: string) => void
  onClear: () => void
  /** Selected aircraft profile: imported logs are attributed to it (a GPX file carries no aircraft). */
  importAircraft?: { id: string; registration: string }
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

export default function FlightLogs({ selectedLogId, onSelect, onClear, importAircraft }: Props) {
  const [logs, setLogs] = useState<{ doc: FlightLogDocType; stats: LogStats | null }[]>([])
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [period, setPeriod] = useState<LogPeriod>('all')
  const [reg, setReg] = useState('')  // '' = all aircraft

  const registrations = useMemo(
    () => [...new Set(logs.map(l => l.doc.registration).filter(Boolean))].sort(),
    [logs],
  )
  const shown = useMemo(() => {
    const from = logPeriodStart(period)
    return logs.filter(l => l.doc.startedAt >= from && (!reg || l.doc.registration === reg))
  }, [logs, period, reg])
  const totals = useMemo(() => logTotals(shown.map(l => ({ ...l.doc, stats: l.stats }))), [shown])

  async function handleDelete(id: string) {
    const db = await getDb()
    const doc = await db.flight_logs.findOne(id).exec()
    await doc?.remove()
    setDeleteId(null)
    if (id === selectedLogId) onClear()
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const doc = {
        ...gpxToFlightLog(await file.text(), crypto.randomUUID()),
        ...(importAircraft ? { aircraftId: importAircraft.id, registration: importAircraft.registration } : {}),
      }
      const db = await getDb()
      // Same start and end as an existing log = the same flight imported twice.
      const dup = await db.flight_logs.findOne({ selector: { startedAt: doc.startedAt, endedAt: doc.endedAt } }).exec()
      if (dup) { setImportMsg('This flight is already in your logs.'); return }
      await db.flight_logs.insert(doc)
      setImportMsg(`Imported ${doc.distanceNm.toFixed(1)} NM flight.`)
    } catch (err) {
      setImportMsg(err instanceof Error ? err.message : 'Could not import this GPX file.')
    }
  }

  function handleExport(log: FlightLogDocType) {
    try {
      const { filename, xml } = flightLogToGpx(log)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([xml], { type: 'application/gpx+xml' }))
      a.download = filename
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Export failed')
    }
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
      <div className={css.clearRow}>
        <button className={css.clearBtn} onClick={() => fileRef.current?.click()}>↑ Import GPX</button>
        <input ref={fileRef} type="file" accept=".gpx,application/gpx+xml" hidden aria-label="Import GPX flight" onChange={handleImport} />
      </div>
      {importMsg && <p className={css.empty}>{importMsg}</p>}
      </div>
    )
  }

  return (
    <div className={css.panel}>
      <div className={css.clearRow}>
        <button className={css.clearBtn} onClick={() => fileRef.current?.click()}>↑ Import GPX</button>
        <input ref={fileRef} type="file" accept=".gpx,application/gpx+xml" hidden aria-label="Import GPX flight" onChange={handleImport} />
      </div>
      {importMsg && <p className={css.empty}>{importMsg}</p>}
      {selectedLogId && (
        <div className={css.clearRow}>
          <button className={css.clearBtn} onClick={onClear}>Clear track</button>
        </div>
      )}
      <div className={css.filters}>
        <select className={css.filterSel} value={period} onChange={e => setPeriod(e.target.value as LogPeriod)} aria-label="Period">
          {LOG_PERIODS.map(p => <option key={p} value={p}>{LOG_PERIOD_LABEL[p]}</option>)}
        </select>
        {registrations.length > 1 && (
          <select className={css.filterSel} value={reg} onChange={e => setReg(e.target.value)} aria-label="Aircraft">
            <option value="">All aircraft</option>
            {registrations.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        )}
      </div>
      <div className={css.totals}>
        {totals.logs} flight{totals.logs === 1 ? '' : 's'} · {formatLogDuration(totals.airborneMs)} · {totals.landings} landing{totals.landings === 1 ? '' : 's'} · {Math.round(totals.distanceNm)} NM
      </div>
      <div className={css.list}>
        {shown.length === 0 && <p className={css.empty}>No flights match this filter.</p>}
        {shown.map(({ doc: log, stats }) => {
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
                    <button className={css.viewBtn} title="Export as GPX" onClick={() => handleExport(log)}>GPX</button>
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
