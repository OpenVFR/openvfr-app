import { useState, useEffect } from 'react'
import type { LegOverride } from '../db/index'
import { type Units, DEFAULT_UNITS, nmToDisplay, distLabel, ktsToDisplay, displayToKts, speedLabel } from '../utils/units'
import { fetchWind } from '@open-vfr/shared/fetchWind'
import type { GlobalWind } from '../db/useSettings'
import css from './LegPropsPanel.module.css'
import { iasToTas } from '@open-vfr/shared/airspeed'

interface Props {
  legIndex: number
  fromName: string
  toName:   string
  distNm:   number
  trueBrg:  number
  magBrg:   number
  /** Leg midpoint coordinates — used to fetch winds-aloft. */
  midLat:   number
  midLng:   number
  override: LegOverride
  units?:   Units
  /** Altitude (ft) assumed when the leg has none: the aircraft's cruise altitude (IAS→TAS conversion). */
  defaultAltFt?: number
  /** Session-wide wind fallback — used when the leg has no saved wind and skips API fetch. */
  globalWind?: GlobalWind | null
  /** Current note on the destination waypoint (legIndex + 1). */
  wpNote?: string
  /** Called when the pilot saves or clears the destination waypoint note. */
  onSaveNote?: (destWpIdx: number, note: string) => void
  onSave:   (idx: number, override: LegOverride) => void
  onClose:  () => void
}

// Parse a numeric field; returns undefined if blank or NaN.
function parseField(val: string): number | undefined {
  const n = parseFloat(val)
  return val.trim() === '' || isNaN(n) ? undefined : n
}

export default function LegPropsPanel({
  legIndex, fromName, toName, distNm, trueBrg, magBrg,
  midLat, midLng, override, units = DEFAULT_UNITS, defaultAltFt, globalWind, wpNote, onSaveNote, onSave, onClose,
}: Props) {
  const [altFt,    setAltFt]    = useState(override.altFt    != null ? String(override.altFt)    : '')
  // Speed field is stored in kts internally; display in selected speed unit.
  const [speedKts, setSpeedKts] = useState(
    override.speedKts != null ? String(Math.round(ktsToDisplay(override.speedKts, units.speed))) : ''
  )
  const [windDir,  setWindDir]  = useState(override.windDir  != null ? String(override.windDir)  : '')
  const [windSpd,  setWindSpd]  = useState(
    override.windSpd != null ? String(Math.round(ktsToDisplay(override.windSpd, units.speed))) : ''
  )
  const [oatC, setOatC] = useState(override.oatC != null ? String(override.oatC) : '')
  const [note, setNote] = useState(wpNote ?? '')
  const [windLoading, setWindLoading] = useState(false)

  // Re-populate if the panel is re-used for a different leg.
  // Intentionally omits `override` from deps — it's used only for initialisation.
  // Including it would reset inputs on every parent re-render (e.g. when override
  // is `legOverrides[idx] ?? {}`, which creates a new object reference each time).
  useEffect(() => {
    setAltFt   (override.altFt    != null ? String(override.altFt)    : '')
    setSpeedKts(override.speedKts != null ? String(Math.round(ktsToDisplay(override.speedKts, units.speed))) : '')
    // Wind: per-leg override → globalWind fallback → blank (API fetch will fill)
    const effDir = override.windDir  ?? globalWind?.dirDeg
    const effSpd = override.windSpd  ?? globalWind?.speedKts
    setWindDir (effDir != null ? String(Math.round(effDir))                               : '')
    setWindSpd (effSpd != null ? String(Math.round(ktsToDisplay(effSpd, units.speed)))    : '')
    setOatC(override.oatC != null ? String(override.oatC) : '')
    setNote(wpNote ?? '')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legIndex, units.speed])

  // Auto-fetch winds-aloft when the panel opens for a leg with no saved wind
  // AND no global wind is set. If globalWind is provided, it was already pre-filled
  // above and no API call is needed.
  useEffect(() => {
    // Wind is fetched only when none is saved and no global wind is set; the
    // forecast temperature (for the IAS->TAS conversion) whenever none is saved.
    const needWind = override.windDir == null && override.windSpd == null && !globalWind
    const needOat  = override.oatC == null
    if (!needWind && !needOat) return
    const controller = new AbortController()
    if (needWind) setWindLoading(true)
    const altNum = parseField(altFt) ?? override.altFt ?? defaultAltFt ?? null
    fetchWind(midLat, midLng, altNum, '', controller.signal)
      .then((w) => {
        if (needWind) {
          setWindDir(String(w.dirDeg))
          setWindSpd(String(Math.round(ktsToDisplay(w.speedKts, units.speed))))
        }
        if (needOat && w.tempC != null) setOatC(String(w.tempC))
      })
      .catch((err: unknown) => {
        // AbortError is expected on cleanup — suppress it silently.
        if ((err as { name?: string }).name !== 'AbortError') {
          console.warn('Wind fetch failed:', err)
        }
      })
      .finally(() => setWindLoading(false))
    return () => controller.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legIndex, midLat, midLng])

  // Derived ground-speed + ETE when enough data is present.
  // speedKts field contains display-unit value; convert back to kts for calculations.
  const spd  = parseField(speedKts) != null ? displayToKts(parseField(speedKts)!, units.speed) : undefined
  const wDir = parseField(windDir)
  // windSpd field also in display unit
  const wSpd = parseField(windSpd)  != null ? displayToKts(parseField(windSpd)!,  units.speed) : undefined

  let gs: number | undefined
  let eteMin: number | undefined
  const tasKts = spd != null && spd > 0 ? iasToTas(spd, parseField(altFt) ?? defaultAltFt ?? 3500, parseField(oatC)) : undefined

  if (spd != null && spd > 0) {
    if (wDir != null && wSpd != null && wSpd > 0) {
      // Wind correction angle (WCA) and ground speed via vector triangle.
      // The entered speed is IAS; wind correction uses TAS at the leg altitude.
      const brg  = (trueBrg * Math.PI) / 180
      const wRad = (wDir    * Math.PI) / 180
      // Headwind/crosswind components
      const hw = wSpd * Math.cos(wRad - brg) // positive = headwind
      const xw = wSpd * Math.sin(wRad - brg)
      const wca = Math.asin(Math.max(-1, Math.min(1, xw / tasKts!))) // capped to ±1
      gs = Math.round(tasKts! * Math.cos(wca) - hw)
    } else {
      gs = Math.round(tasKts!)
    }
    if (gs > 0) eteMin = (distNm / gs) * 60
  }

  function handleSave() {
    const rawSpeed = parseField(speedKts)
    const rawWind  = parseField(windSpd)
    onSave(legIndex, {
      altFt:    parseField(altFt),
      speedKts: rawSpeed != null ? displayToKts(rawSpeed, units.speed) : undefined,
      windDir:  parseField(windDir),
      windSpd:  rawWind  != null ? displayToKts(rawWind,  units.speed) : undefined,
      oatC:     parseField(oatC),
    })
    onSaveNote?.(legIndex + 1, note.trim())
    onClose()
  }

  function handleClear() {
    onSave(legIndex, {})
    onSaveNote?.(legIndex + 1, '')
    onClose()
  }

  return (
    <div className={css.panel}>
      <div className={css.header}>
        <span className={css.title}>Leg {legIndex + 1}</span>
        <span className={css.route}>{fromName} → {toName}</span>
        <button className={css.close} onClick={onClose} title="Close">✕</button>
      </div>

      {/* Read-only info row */}
      <div className={css.infoRow}>
        <span className={css.infoItem}><span className={css.infoLabel}>Dist</span> {nmToDisplay(distNm, units.distance).toFixed(1)} {distLabel(units.distance)}</span>
        <span className={css.infoItem}><span className={css.infoLabel}>Mag</span> {String(Math.round(magBrg)).padStart(3, '0')}°M</span>
        <span className={css.infoItem}><span className={css.infoLabel}>True</span> {String(Math.round(trueBrg)).padStart(3, '0')}°T</span>
      </div>

      {/* Editable fields */}
      <div className={css.fields}>
        <label className={css.field}>
          <span className={css.label}>Alt (ft)</span>
          <input
            className={css.input}
            type="number"
            min={0}
            max={50000}
            step={100}
            placeholder="e.g. 3500"
            value={altFt}
            onChange={e => setAltFt(e.target.value)}
          />
        </label>

        <label className={css.field}>
          <span className={css.label}>IAS ({speedLabel(units.speed)})</span>
          <input
            className={css.input}
            type="number"
            min={0}
            max={units.speed === 'kmh' ? 926 : 500}
            step={1}
            placeholder={units.speed === 'kmh' ? 'e.g. 185' : 'e.g. 100'}
            value={speedKts}
            onChange={e => setSpeedKts(e.target.value)}
          />
        </label>

        <label className={css.field}>
          <span className={css.label}>Wind from (°T){windLoading ? ' …' : ''}</span>
          <input
            className={css.input}
            type="number"
            min={0}
            max={359}
            step={1}
            placeholder="e.g. 270"
            value={windDir}
            disabled={windLoading}
            onChange={e => setWindDir(e.target.value)}
          />
        </label>

        <label className={css.field}>
          <span className={css.label}>Wind spd ({speedLabel(units.speed)}){windLoading ? ' …' : ''}</span>
          <input
            className={css.input}
            type="number"
            min={0}
            max={units.speed === 'kmh' ? 370 : 200}
            step={1}
            placeholder={units.speed === 'kmh' ? 'e.g. 28' : 'e.g. 15'}
            value={windSpd}
            disabled={windLoading}
            onChange={e => setWindSpd(e.target.value)}
          />
        </label>

        <label className={css.field}>
          <span className={css.label}>OAT (°C)</span>
          <input
            className={css.input}
            type="number"
            min={-70}
            max={50}
            step={1}
            placeholder="ISA"
            title="Outside air temperature at the leg altitude (forecast, editable). Blank = standard atmosphere. Used to convert IAS to true airspeed."
            value={oatC}
            onChange={e => setOatC(e.target.value)}
          />
        </label>
      </div>

      {/* Derived TAS + GS + ETE */}
      {(gs != null || eteMin != null) && (
        <div className={css.derived}>
          {tasKts  != null && <span><span className={css.infoLabel}>TAS</span> {Math.round(ktsToDisplay(tasKts, units.speed))} {speedLabel(units.speed)}</span>}
          {gs      != null && <span><span className={css.infoLabel}>GS</span> {Math.round(ktsToDisplay(gs, units.speed))} {speedLabel(units.speed)}</span>}
          {eteMin  != null && (
            <span>
              <span className={css.infoLabel}>ETE</span>{' '}
              {Math.floor(eteMin)}:{String(Math.round((eteMin % 1) * 60)).padStart(2, '0')}
            </span>
          )}
        </div>
      )}

      {/* Turning-point reminder note */}
      <div className={css.noteSection}>
        <label className={css.noteLabel} htmlFor="leg-note">
          Note at {toName}
        </label>
        <textarea
          id="leg-note"
          className={css.noteInput}
          rows={2}
          maxLength={200}
          placeholder="Reminder shown when this turning point becomes active…"
          value={note}
          onChange={e => setNote(e.target.value)}
        />
      </div>

      <div className={css.footer}>
        <button className={css.btnClear} onClick={handleClear}>Clear</button>
        <button className={css.btnSave}  onClick={handleSave}>Apply</button>
      </div>
    </div>
  )
}
