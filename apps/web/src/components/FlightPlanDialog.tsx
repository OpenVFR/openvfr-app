/**
 * ICAO flight plan for the route and aircraft: the per-flight answers (rules,
 * time, persons on board, survival equipment, pilot), the message and item 19
 * as text to check and copy, and what is still missing. Nothing is sent from
 * here: the text is filed with the ATS service you use.
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconX } from '@tabler/icons-react'
import { buildFpl, EMPTY_ANSWERS, FLIGHT_RULES_LABELS, FLIGHT_TYPE_LABELS, type FlightAnswers, type FlightRules, type FlightType, type LevelMode } from '@open-vfr/shared/fplMessage'
import type { AircraftProfileDocType } from '@open-vfr/shared/types'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { LegOverride } from '../db/index'
import css from './FlightPlanDialog.module.css'

const STORE = 'openvfr.fplDefaults'

/** What stays the same from flight to flight: the pilot and the aircraft's emergency equipment. */
type Defaults = Pick<FlightAnswers, 'pilotName' | 'pilotPhone' | 'emergencyRadio' | 'survival' | 'jackets' | 'dinghies'>
function loadDefaults(): Partial<Defaults> {
  try { return JSON.parse(localStorage.getItem(STORE) ?? '{}') as Partial<Defaults> } catch { return {} }
}

const SURVIVAL: [string, string][] = [['P', 'Polar'], ['D', 'Desert'], ['M', 'Maritime'], ['J', 'Jungle']]
const JACKETS: [string, string][] = [['L', 'Light'], ['F', 'Fluorescein'], ['U', 'UHF radio'], ['V', 'VHF radio']]
const RADIOS: [string, string][] = [['U', 'UHF'], ['V', 'VHF 121.5'], ['E', 'ELT']]

function toggle<T extends string>(list: readonly T[], v: T): T[] {
  return list.includes(v) ? list.filter(x => x !== v) : [...list, v]
}

/** A local date and time input value for a Date, shown in UTC. */
const utcInput = (d: Date) => d.toISOString().slice(0, 16)

export default function FlightPlanDialog({ waypoints, legOverrides, aircraft, legWinds, takeoffTime, alternateIcao, accountName, onClose }: {
  waypoints: RouteWaypoint[]
  legOverrides: LegOverride[]
  aircraft: AircraftProfileDocType
  legWinds?: ({ dirDeg: number; speedKts: number } | null)[]
  takeoffTime: Date | null
  alternateIcao?: string
  accountName?: string
  onClose: () => void
}) {
  const [flight, setFlight] = useState<FlightAnswers>(() => {
    const saved = loadDefaults()
    return {
      ...EMPTY_ANSWERS, ...saved,
      eobt: takeoffTime ?? new Date(Math.ceil((Date.now() + 30 * 60_000) / 300_000) * 300_000),
      alternate: alternateIcao,
      pilotName: saved.pilotName || accountName || '',
    }
  })
  const [copied, setCopied] = useState('')
  const set = <K extends keyof FlightAnswers>(k: K, v: FlightAnswers[K]) => setFlight(f => ({ ...f, [k]: v }))

  useEffect(() => {
    const d: Defaults = { pilotName: flight.pilotName, pilotPhone: flight.pilotPhone, emergencyRadio: flight.emergencyRadio, survival: flight.survival, jackets: flight.jackets, dinghies: flight.dinghies }
    try { localStorage.setItem(STORE, JSON.stringify(d)) } catch { /* private mode: nothing is kept */ }
  }, [flight.pilotName, flight.pilotPhone, flight.emergencyRadio, flight.survival, flight.jackets, flight.dinghies])

  const fpl = useMemo(() => buildFpl({ waypoints, legOverrides, aircraft, legWinds, flight }), [waypoints, legOverrides, aircraft, legWinds, flight])

  async function copy(what: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(''), 1500) } catch { /* the text stays selectable */ }
  }

  const eobtOk = !Number.isNaN(flight.eobt.getTime())
  return createPortal(
    <div className={css.backdrop} role="dialog" aria-modal="true" aria-labelledby="fpl-title" onClick={onClose}>
      <div className={css.card} onClick={e => e.stopPropagation()}>
        <div className={css.head}>
          <h2 id="fpl-title" className={css.title}>ICAO flight plan</h2>
          <button type="button" className={css.close} aria-label="Close" onClick={onClose}><IconX size={16} aria-hidden="true" /></button>
        </div>
        <p className={css.note}>A draft built from your route and aircraft. Check it, then file it with the ATS service you use. Nothing is sent from OpenVFR.</p>

        <div className={css.grid}>
          <label className={css.lbl}>Flight rules
            <select className={css.inp} value={flight.rules} onChange={e => set('rules', e.target.value as FlightRules)}>
              {(Object.keys(FLIGHT_RULES_LABELS) as FlightRules[]).map(r => <option key={r} value={r}>{r}: {FLIGHT_RULES_LABELS[r]}</option>)}
            </select>
          </label>
          <label className={css.lbl}>Type of flight
            <select className={css.inp} value={flight.type} onChange={e => set('type', e.target.value as FlightType)}>
              {(Object.keys(FLIGHT_TYPE_LABELS) as FlightType[]).map(t => <option key={t} value={t}>{t}: {FLIGHT_TYPE_LABELS[t]}</option>)}
            </select>
          </label>
          <label className={css.lbl}>Level in the plan
            <select className={css.inp} value={flight.levelMode} onChange={e => set('levelMode', e.target.value as LevelMode)}>
              <option value="VFR">VFR (the word, no level)</option>
              <option value="planned">Planned levels (with the changes)</option>
            </select>
          </label>
          <label className={css.lbl}>Off-block time (UTC)
            <input className={css.inp} type="datetime-local" value={eobtOk ? utcInput(flight.eobt) : ''}
              onChange={e => { const d = new Date(`${e.target.value}:00Z`); if (!Number.isNaN(d.getTime())) set('eobt', d) }} />
          </label>
          <label className={css.lbl}>Alternate (ICAO)
            <input className={css.inp} value={flight.alternate ?? ''} placeholder="ESSA" maxLength={4}
              onChange={e => set('alternate', e.target.value.toUpperCase() || undefined)} />
          </label>
          <label className={css.lbl}>Persons on board
            <input className={css.inp} type="number" min={1} value={flight.personsOnBoard}
              onChange={e => set('personsOnBoard', Math.max(0, Math.round(Number(e.target.value) || 0)))} />
          </label>
          <label className={css.lbl}>Pilot in command
            <input className={css.inp} value={flight.pilotName} onChange={e => set('pilotName', e.target.value)} />
          </label>
          <label className={css.lbl}>Phone (reachable until EOBT)
            <input className={css.inp} type="tel" value={flight.pilotPhone} placeholder="+46 70 123 45 67" onChange={e => set('pilotPhone', e.target.value)} />
          </label>
        </div>

        <fieldset className={css.set}><legend>Emergency radio</legend>
          {RADIOS.map(([c, l]) => <label key={c} className={css.chk}><input type="checkbox" checked={flight.emergencyRadio.includes(c as 'U')} onChange={() => set('emergencyRadio', toggle(flight.emergencyRadio, c as 'U'))} /> {l}</label>)}
        </fieldset>
        <fieldset className={css.set}><legend>Survival equipment</legend>
          {SURVIVAL.map(([c, l]) => <label key={c} className={css.chk}><input type="checkbox" checked={flight.survival.includes(c as 'P')} onChange={() => set('survival', toggle(flight.survival, c as 'P'))} /> {l}</label>)}
        </fieldset>
        <fieldset className={css.set}><legend>Life jackets</legend>
          {JACKETS.map(([c, l]) => <label key={c} className={css.chk}><input type="checkbox" checked={flight.jackets.includes(c as 'L')} onChange={() => set('jackets', toggle(flight.jackets, c as 'L'))} /> {l}</label>)}
        </fieldset>
        <fieldset className={css.set}><legend>Dinghies</legend>
          <label className={css.chk}>Number <input className={css.num} type="number" min={0} value={flight.dinghies.count} onChange={e => set('dinghies', { ...flight.dinghies, count: Math.max(0, Number(e.target.value) || 0) })} /></label>
          <label className={css.chk}>Capacity <input className={css.num} type="number" min={0} value={flight.dinghies.capacity} onChange={e => set('dinghies', { ...flight.dinghies, capacity: Math.max(0, Number(e.target.value) || 0) })} /></label>
          <label className={css.chk}><input type="checkbox" checked={flight.dinghies.covered} onChange={e => set('dinghies', { ...flight.dinghies, covered: e.target.checked })} /> Covered</label>
          <label className={css.chk}>Colour <input className={css.txt} value={flight.dinghies.colour} onChange={e => set('dinghies', { ...flight.dinghies, colour: e.target.value })} /></label>
        </fieldset>
        <label className={css.lbl}>Remarks
          <input className={css.inp} value={flight.remarks} onChange={e => set('remarks', e.target.value)} />
        </label>

        {fpl.problems.length > 0 && (
          <div className={css.problems} role="status">
            <strong>Check before you file:</strong>
            <ul>{fpl.problems.map(p => <li key={p}>{p}</li>)}</ul>
          </div>
        )}

        {fpl.text && (
          <>
            <div className={css.outHead}><span>Flight plan message</span><button type="button" className={css.btn} onClick={() => void copy('fpl', fpl.text)}>{copied === 'fpl' ? 'Copied' : 'Copy'}</button></div>
            <pre className={css.out}>{fpl.text}</pre>
            <div className={css.outHead}><span>Item 19, for the filing form</span><button type="button" className={css.btn} onClick={() => void copy('s19', fpl.supplementary.join('\n'))}>{copied === 's19' ? 'Copied' : 'Copy'}</button></div>
            <pre className={css.out}>{fpl.supplementary.join('\n')}</pre>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
