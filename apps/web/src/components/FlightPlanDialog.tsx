/**
 * ICAO flight plan for the route and aircraft: the per-flight answers (rules,
 * time, persons on board, survival equipment, pilot), the message and item 19
 * as text to check and copy, and what is still missing. Nothing is sent from
 * here: the text is filed with the ATS service you use.
 */
import { useEffect, useMemo, useState } from 'react'
import { useModalFocus } from '../hooks/useModalFocus'
import { createPortal } from 'react-dom'
import { IconX } from '@tabler/icons-react'
import { getDb } from '../db/index'
import { loadCountryGeojson } from '@open-vfr/shared/countryData'
import {
  aerodromeCodes, buildFpl, defaultEobt, EMPTY_ANSWERS, FLIGHT_RULES_LABELS, FLIGHT_TYPE_LABELS, FPL_DEFAULT_KEYS, FPL_JACKETS, FPL_RADIOS, FPL_SURVIVAL,
  fplAircraftPatch, toggleItem, type FlightAnswers, type FlightRules, type FlightType, type FplDefaults, type LevelMode,
} from '@open-vfr/shared/fplMessage'
import { normaliseIcaoType } from '@open-vfr/shared/icaoFlightPlan'
import type { AircraftProfileDocType, TransponderMode } from '@open-vfr/shared/types'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { LegOverride } from '../db/index'
import css from './FlightPlanDialog.module.css'

const STORE = 'openvfr.fplDefaults'

function loadDefaults(): Partial<FplDefaults> {
  try { return JSON.parse(localStorage.getItem(STORE) ?? '{}') as Partial<FplDefaults> } catch { return {} }
}

/** A local date and time input value for a Date, shown in UTC. */
const utcInput = (d: Date) => d.toISOString().slice(0, 16)

export default function FlightPlanDialog({ waypoints, legOverrides, aircraft: aircraftProp, legWinds, takeoffTime, alternateIcao, accountName, returnFocusTo, onClose }: {
  waypoints: RouteWaypoint[]
  legOverrides: LegOverride[]
  aircraft: AircraftProfileDocType
  legWinds?: ({ dirDeg: number; speedKts: number } | null)[]
  takeoffTime: Date | null
  alternateIcao?: string
  accountName?: string
  /** Where focus goes when the dialog closes (the menu button that opened it). */
  returnFocusTo?: HTMLElement | null
  onClose: () => void
}) {
  const [flight, setFlight] = useState<FlightAnswers>(() => {
    const saved = loadDefaults()
    return {
      ...EMPTY_ANSWERS, ...saved,
      eobt: takeoffTime ?? defaultEobt(),
      alternate: alternateIcao,
      pilotName: saved.pilotName || accountName || '',
    }
  })
  const [copied, setCopied] = useState('')
  const [notice, setNotice] = useState('')
  // The aircraft as edited here: details missing for the plan can be filled in and saved to the profile.
  const [aircraft, setAircraft] = useState(aircraftProp)
  const [saved, setSaved] = useState(true)
  const [saveError, setSaveError] = useState('')
  const setAc = (patch: Partial<AircraftProfileDocType>) => { setAircraft(a => ({ ...a, ...patch })); setSaved(false); setSaveError('') }
  async function saveAircraft() {
    try {
      const db = await getDb()
      const doc = await db.aircraft_profiles.findOne(aircraft.id).exec()
      if (!doc) { setSaveError('The aircraft profile was not found, so nothing was saved.'); return }
      await doc.patch({ ...fplAircraftPatch(aircraft), updatedAt: Date.now() })
      setSaved(true); setSaveError('')
    } catch {
      setSaveError('Could not save to the aircraft profile. The plan below still uses what you typed.')
    }
  }
  const equipMode = aircraft.equipment?.length === 1 && ['N', 'S'].includes(aircraft.equipment[0]!) ? aircraft.equipment[0]! : aircraft.equipment?.length ? 'custom' : 'unset'
  const set = <K extends keyof FlightAnswers>(k: K, v: FlightAnswers[K]) => setFlight(f => ({ ...f, [k]: v }))

  useEffect(() => {
    const d = Object.fromEntries(FPL_DEFAULT_KEYS.map(k => [k, flight[k]])) as FplDefaults
    try { localStorage.setItem(STORE, JSON.stringify(d)) } catch { /* private mode: nothing is kept */ }
  }, [flight.pilotName, flight.pilotPhone, flight.emergencyRadio, flight.survival, flight.jackets, flight.dinghies])

  // The known aerodromes, so only real ones are written as codes (undefined while loading or when they could not be loaded).
  const [aerodromes, setAerodromes] = useState<Set<string> | undefined>(undefined)
  useEffect(() => {
    let live = true
    loadCountryGeojson('aerodromes').then(fc => { if (live) setAerodromes(aerodromeCodes(fc)) }).catch(() => {})
    return () => { live = false }
  }, [])
  const fpl = useMemo(() => buildFpl({ waypoints, legOverrides, aircraft, legWinds, flight, ...(aerodromes ? { aerodromes } : {}) }), [waypoints, legOverrides, aircraft, legWinds, flight, aerodromes])

  async function copy(what: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what); setNotice('Copied.'); setTimeout(() => { setCopied(''); setNotice('') }, 1500)
    } catch {
      // No clipboard access: select the text so it can be copied by hand.
      const el = document.getElementById(`fpl-out-${what}`)
      if (el) { const r = document.createRange(); r.selectNodeContents(el); const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r) }
      setNotice('Could not copy. The text is selected: copy it by hand.')
    }
  }

  const cardRef = useModalFocus(onClose, returnFocusTo)

  const eobtOk = !Number.isNaN(flight.eobt.getTime())
  return createPortal(
    <div className={css.backdrop} role="dialog" aria-modal="true" aria-labelledby="fpl-title">
      <div className={css.card} ref={cardRef}>
        <div className={css.head}>
          <h2 id="fpl-title" className={css.title}>Export ICAO flight plan</h2>
          <button type="button" className={css.close} aria-label="Close" onClick={onClose}><IconX size={16} aria-hidden="true" /></button>
        </div>
        <p className={css.note}>A draft built from your route and aircraft. Fill in what is asked, check the list, then copy it into the filing service you use. Nothing is sent from OpenVFR.</p>

        <fieldset className={css.set}>
          <legend>Aircraft details for the plan</legend>
          <div className={css.grid}>
            <label className={css.lbl}>Registration
              <input className={css.inp} value={aircraft.registration} placeholder="SE-ABC" onChange={e => setAc({ registration: e.target.value.toUpperCase() })} />
            </label>
            <label className={css.lbl}>ICAO type (or ZZZZ)
              <input className={css.inp} value={aircraft.icaoType ?? ''} placeholder="C172" maxLength={4} onChange={e => setAc({ icaoType: normaliseIcaoType(e.target.value) })} />
            </label>
            <label className={css.lbl}>Colour and markings
              <input className={css.inp} value={aircraft.colour ?? ''} placeholder="White with blue stripes" onChange={e => setAc({ colour: e.target.value })} />
            </label>
            <label className={css.lbl}>Transponder
              <select className={css.inp} value={aircraft.transponder ?? ''} onChange={e => setAc({ transponder: (e.target.value || undefined) as TransponderMode | undefined })}>
                <option value="">Not set</option>
                <option value="none">None</option>
                <option value="A">Mode A</option>
                <option value="C">Mode C</option>
                <option value="S">Mode S</option>
              </select>
            </label>
            <label className={css.lbl}>Radio / nav
              <select className={css.inp} value={equipMode} onChange={e => { const v = e.target.value; if (v !== 'custom') setAc({ equipment: v === 'unset' ? undefined : [v], hasRadio: undefined }) }}>
                <option value="unset">Not set</option>
                <option value="N">None (N)</option>
                <option value="custom" disabled>Chosen letters (edit in the aircraft profile)</option>
                <option value="S">Standard (S)</option>
              </select>
            </label>
          </div>
          {!saved && <button type="button" className={css.btn} onClick={() => void saveAircraft()}>Save to the aircraft profile</button>}
          {saveError && <div className={css.error} role="alert">{saveError}</div>}
        </fieldset>

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
          <label className={css.lbl}>Cruising level
            <select className={css.inp} value={flight.levelMode} onChange={e => set('levelMode', e.target.value as LevelMode)}>
              <option value="VFR">VFR (word only)</option>
              <option value="planned">Altitudes from the route</option>
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
            <input className={css.inp} type="number" min={1} value={flight.personsOnBoard} disabled={!!flight.personsUnknown}
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
          {FPL_RADIOS.map(([c, l]) => <label key={c} className={css.chk}><input type="checkbox" checked={flight.emergencyRadio.includes(c as 'U')} onChange={() => set('emergencyRadio', toggleItem(flight.emergencyRadio, c as 'U'))} /> {l}</label>)}
        </fieldset>
        <fieldset className={css.set}><legend>Survival equipment</legend>
          {FPL_SURVIVAL.map(([c, l]) => <label key={c} className={css.chk}><input type="checkbox" checked={flight.survival.includes(c as 'P')} onChange={() => set('survival', toggleItem(flight.survival, c as 'P'))} /> {l}</label>)}
        </fieldset>
        <fieldset className={css.set}><legend>Life jackets</legend>
          {FPL_JACKETS.map(([c, l]) => <label key={c} className={css.chk}><input type="checkbox" checked={flight.jackets.includes(c as 'L')} onChange={() => set('jackets', toggleItem(flight.jackets, c as 'L'))} /> {l}</label>)}
        </fieldset>
        <fieldset className={css.set}><legend>Life rafts (dinghies)</legend>
          <label className={css.chk}>Number of rafts <input className={css.num} type="number" min={0} value={flight.dinghies.count} onChange={e => set('dinghies', { ...flight.dinghies, count: Math.max(0, Number(e.target.value) || 0) })} /></label>
          <label className={css.chk}>Total capacity (persons) <input className={css.num} type="number" min={0} value={flight.dinghies.capacity} onChange={e => set('dinghies', { ...flight.dinghies, capacity: Math.max(0, Number(e.target.value) || 0) })} /></label>
          <label className={css.chk}><input type="checkbox" checked={flight.dinghies.covered} onChange={e => set('dinghies', { ...flight.dinghies, covered: e.target.checked })} /> With canopy</label>
          <label className={css.chk}>Colour <input className={css.txt} value={flight.dinghies.colour} onChange={e => set('dinghies', { ...flight.dinghies, colour: e.target.value })} /></label>
        </fieldset>
        <label className={css.lbl}>Remarks
          <input className={css.inp} value={flight.remarks} onChange={e => set('remarks', e.target.value)} />
        </label>
        <fieldset className={css.set}><legend>Other information</legend>
          <label className={css.chk}><input type="checkbox" checked={!!flight.personsUnknown} onChange={e => set('personsUnknown', e.target.checked)} /> Persons on board not known yet (written TBN: tell the ATS before taxiing)</label>
          <label className={css.chk}><input type="checkbox" checked={!!flight.jacketsPlain} onChange={e => set('jacketsPlain', e.target.checked)} /> Life jackets carried without light, fluorescein or radio (written as the remark JACKETS)</label>
        </fieldset>

        {fpl.problems.length > 0 && (
          <div className={css.problems}>
            <span className={css.srOnly} aria-live="polite">{fpl.problems.length === 1 ? '1 thing to check' : `${fpl.problems.length} things to check`}</span>
            <strong>Check before you file:</strong>
            <ul>{fpl.problems.map(p => <li key={p}>{p}</li>)}</ul>
          </div>
        )}

        <div className={css.srOnly} aria-live="polite">{notice}</div>
        {notice.startsWith('Could not') && <div className={css.error} role="alert">{notice}</div>}
        {fpl.text && (
          <>
            <div className={css.outHead}><span>Flight plan to paste into a filing form's import (item 19 inside)</span><button type="button" className={css.btn} onClick={() => void copy('imp', fpl.importText)}>{copied === 'imp' ? 'Copied' : 'Copy'}</button></div>
            <pre id="fpl-out-imp" className={css.out}>{fpl.importText}</pre>
            <details className={css.more}>
              <summary>More formats</summary>
              <div className={css.outHead}><span>Flight plan message</span><button type="button" className={css.btn} onClick={() => void copy('fpl', fpl.text)}>{copied === 'fpl' ? 'Copied' : 'Copy'}</button></div>
              <pre id="fpl-out-fpl" className={css.out}>{fpl.text}</pre>
              <div className={css.outHead}><span>Item 19, for the filing form</span><button type="button" className={css.btn} onClick={() => void copy('s19', fpl.supplementary.join('\n'))}>{copied === 's19' ? 'Copied' : 'Copy'}</button></div>
              <pre id="fpl-out-s19" className={css.out}>{fpl.supplementary.join('\n')}</pre>
            </details>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
