import { useEffect, useMemo, useRef, useState } from 'react'
import { flightLogToGpx, gpxToFlightLog } from '@open-vfr/shared/gpx'
import {
  computeLogStats, formatLogDuration, logTotals, logPeriodStart, LOG_PERIODS, LOG_PERIOD_LABEL,
  type LogStats, type LogPeriod,
} from '@open-vfr/shared/flightLogStats'
import { getDb, type FlightLogDocType, type TrackPoint } from '../db'
import { useAircraftProfiles } from '../db/useAircraftProfiles'
import { useSyncRejected } from '../sync/cloudSync'
import SyncRefusedNote from './SyncRefusedNote'
import { flightLogEvents } from '@open-vfr/shared/flightLogEvents'
import { formatElapsed, formatUtcTime, type FlownEvent } from '@open-vfr/shared/flightLogProfile'
import { autoFlyThresholds } from '@open-vfr/shared/autoFlyDetect'
import { loadCountryGeojson } from '@open-vfr/shared/countryData'
import type { AircraftProfileDocType } from '../db'
import css from './FlightLogs.module.css'

const EVENT_ICON: Record<FlownEvent['kind'], string> = {
  takeoff: '\u2197', landing: '\u2198', 'touch-and-go': '\u21c4', gap: '\u26a0', airspace: '\u25a3',
}

/**
 * A log's events (takeoff, landing, touch-and-go, GPS lost, airspace entered),
 * worked out when opened: the track is parsed and the airspace it crosses looked
 * up only then. Picking one opens the log on the map at that moment.
 */
function LogEvents({ log, aircraft, onPick }: {
  log: FlightLogDocType
  aircraft?: AircraftProfileDocType
  onPick: (ts: number) => void
}) {
  const [events, setEvents] = useState<FlownEvent[] | null>(null)
  useEffect(() => {
    let cancelled = false
    const t = autoFlyThresholds(aircraft?.takeoffSpeedKts, aircraft?.category)
    loadCountryGeojson('airspace').catch(() => null).then((airspace) => {
      if (cancelled) return
      try {
        const track = JSON.parse(log.trackJson || '[]') as TrackPoint[]
        setEvents(flightLogEvents(track, airspace, { takeoffKts: t.takeoffKts, landedKts: t.landedKts }))
      } catch { setEvents([]) }
    })
    return () => { cancelled = true }
  }, [log.trackJson, aircraft?.takeoffSpeedKts, aircraft?.category])
  if (events == null) return <div className={css.events}><span className={css.eventsNote}>Working out events…</span></div>
  if (events.length === 0) return <div className={css.events}><span className={css.eventsNote}>No events found.</span></div>
  return (
    <div className={css.events}>
      {events.map((e, i) => (
        <button key={`${e.kind}-${e.index}-${i}`} className={css.eventRow} onClick={() => onPick(e.point.ts)}
          title={`${formatUtcTime(e.point.ts)}. Open the log here.`}>
          <span className={css.eventIcon}>{EVENT_ICON[e.kind]}</span>
          <span className={css.eventTime}>{formatElapsed(e.point.elapsedMs)}</span>
          <span className={e.kind === 'gap' ? css.eventWarn : undefined}>{e.label}</span>
        </button>
      ))}
    </div>
  )
}

interface Props {
  selectedLogId: string | null
  /** `atTs`: open the log inspecting the recorded point at that time. */
  onSelect: (id: string, atTs?: number) => void
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
  const refusedLogs = useSyncRejected('user_flight_logs')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [importMsg, setImportMsg] = useState<string | null>(null)
  // A picked GPX file waiting for its aircraft (a GPX file carries none): confirmed in a small row.
  const [pendingImport, setPendingImport] = useState<{ doc: FlightLogDocType; aircraftId: string } | null>(null)
  const { profiles: aircraftProfiles } = useAircraftProfiles()
  // Logs whose events are open in the list.
  const [eventsOpen, setEventsOpen] = useState<Set<string>>(new Set())
  const toggleEvents = (id: string) => setEventsOpen((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
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
  const simulatedCount = useMemo(() => logs.filter(l => l.doc.simulated === true).length, [logs])

  // Simulated logs never reached the server, so removing them queues no
  // server delete (the sync's change capture skips them).
  async function handleDeleteSimulated() {
    if (!window.confirm(`Delete ${simulatedCount} simulated flight log${simulatedCount === 1 ? '' : 's'} from this browser? Real flights are not affected.`)) return
    const db = await getDb()
    const sims = await db.flight_logs.find({ selector: { endedAt: { $gt: 0 } } }).exec()
    await Promise.all(sims.filter(d => d.simulated === true).map(d => d.remove()))
    if (selectedLogId && logs.some(l => l.doc.id === selectedLogId && l.doc.simulated)) onClear()
  }

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
      const doc: FlightLogDocType = gpxToFlightLog(await file.text(), crypto.randomUUID())
      const db = await getDb()
      // Same start and end as an existing log = the same flight imported twice.
      const dup = await db.flight_logs.findOne({ selector: { startedAt: doc.startedAt, endedAt: doc.endedAt } }).exec()
      if (dup) { setImportMsg('This flight is already in your logs.'); return }
      // Ask which aircraft flew it (the selected one preselected); a log's aircraft is set once.
      setImportMsg(null)
      setPendingImport({ doc, aircraftId: importAircraft?.id ?? '' })
    } catch (err) {
      setImportMsg(err instanceof Error ? err.message : 'Could not import this GPX file.')
    }
  }

  async function confirmImport() {
    if (!pendingImport) return
    const { doc, aircraftId } = pendingImport
    const ac = aircraftProfiles.find(p => p.id === aircraftId)
    setPendingImport(null)
    try {
      const db = await getDb()
      await db.flight_logs.insert({ ...doc, aircraftId: ac?.id ?? '', registration: ac?.registration ?? '', updatedAt: Date.now() })
      setImportMsg(`Imported ${doc.distanceNm.toFixed(1)} NM flight${ac ? ` (${ac.registration || ac.name})` : ''}.`)
    } catch (err) {
      setImportMsg(err instanceof Error ? err.message : 'Could not import this GPX file.')
    }
  }

  const importConfirm = pendingImport && (
    <div className={css.importConfirm}>
      <span className={css.importInfo}>
        {new Date(pendingImport.doc.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
        {' · '}{pendingImport.doc.distanceNm.toFixed(1)} NM. Aircraft:
      </span>
      <select
        className={css.filterSel}
        value={pendingImport.aircraftId}
        onChange={e => setPendingImport({ ...pendingImport, aircraftId: e.target.value })}
        aria-label="Aircraft for the imported flight"
      >
        <option value="">None</option>
        {aircraftProfiles.map(p => <option key={p.id} value={p.id}>{p.registration || p.name}</option>)}
      </select>
      <button className={css.clearBtn} onClick={() => void confirmImport()}>Import</button>
      <button className={css.clearBtn} onClick={() => setPendingImport(null)}>Cancel</button>
    </div>
  )

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
      {importConfirm}
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
      {importConfirm}
      {importMsg && <p className={css.empty}>{importMsg}</p>}
      {selectedLogId && (
        <div className={css.clearRow}>
          <button className={css.clearBtn} onClick={onClear}>Clear track</button>
        </div>
      )}
      {simulatedCount > 0 && (
        <div className={css.clearRow}>
          <button className={css.clearBtn} onClick={handleDeleteSimulated}>Delete simulated ({simulatedCount})</button>
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
                <span className={css.itemTitle}>
                  {log.simulated && <span className={css.simBadge} title="Simulated flight: kept in this browser, not synced, not in totals">SIM</span>}
                  {depArr}
                </span>
                <div className={css.itemMeta}>
                  <span className={css.itemMetaVal}>{fmt(log.startedAt)}</span>
                  <span className={css.itemMetaVal}>{log.distanceNm.toFixed(1)} NM</span>
                  <span className={css.itemMetaVal}>
                    {formatLogDuration(stats && stats.airborneMs > 0 ? stats.airborneMs : log.endedAt - log.startedAt)}
                  </span>
                  {stats && stats.landings > 0 && <span className={css.itemMetaVal}>{landingsLabel(stats)}</span>}
                  {log.maxAltFt > 0 && <span className={css.itemMetaVal}>max {Math.round(log.maxAltFt).toLocaleString()} ft</span>}
                  {stats && stats.gapCount > 0 && <span className={css.itemMetaVal} title="GPS track has gaps">⚠ gaps</span>}
                  <button className={css.eventsToggle} onClick={() => toggleEvents(log.id)} aria-expanded={eventsOpen.has(log.id)}>
                    {eventsOpen.has(log.id) ? '\u25be' : '\u25b8'} Events
                  </button>
                </div>
                <SyncRefusedNote row={refusedLogs.get(log.id)} />
                {eventsOpen.has(log.id) && (
                  <LogEvents log={log} aircraft={aircraftProfiles.find((p) => p.id === log.aircraftId)} onPick={(ts) => onSelect(log.id, ts)} />
                )}
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
