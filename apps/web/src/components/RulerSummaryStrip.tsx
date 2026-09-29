import css from './RulerSummaryStrip.module.css'
import type { RouteWaypoint } from '../utils/routeCalc'
import { bearingDeg, distanceNm, magneticBearingDeg } from '../utils/routeCalc'
import type { Units } from '../utils/units'
import { nmToDisplay, distLabel } from '../utils/units'
import type { AircraftProfileDocType } from '../db/index'

interface Props {
  from: RouteWaypoint
  to: RouteWaypoint
  units: Units
  aircraftProfile?: AircraftProfileDocType
  onClear: () => void
}

function fmtTime(hours: number): string {
  const totalMin = Math.round(hours * 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h === 0 ? `${m}min` : `${h}h${m.toString().padStart(2, '0')}`
}

function fmtBrg(deg: number): string {
  return `${Math.round(deg).toString().padStart(3, '0')}°`
}

/**
 * Map Ruler readout, shown directly above the VirtualRadar elevation profile
 * while ruler mode is active: DIST, TRUE and MAG, plus ETE and FUEL when an
 * aircraft with a cruise speed is selected (no wind applied). It is the only
 * place the measurement is shown, so it cannot be scrolled out of view.
 */
export default function RulerSummaryStrip({ from, to, units, aircraftProfile, onClear }: Props) {
  const distNm      = distanceNm(from, to)
  const distDisplay = nmToDisplay(distNm, units.distance)
  const trueBrg     = bearingDeg(from, to)
  const magBrg      = magneticBearingDeg(from, to)
  // ETE and fuel need an aircraft with a cruise speed (no wind applied).
  const cruiseKts = aircraftProfile?.cruiseIas ?? null
  const eteHours  = cruiseKts && cruiseKts > 0 ? distNm / cruiseKts : null
  const fuelL     = eteHours != null && aircraftProfile ? eteHours * aircraftProfile.fuelBurnLhr : null

  return (
    <div className={css.strip}>
      <span className={css.item}>
        <span className={css.label}>DIST</span>
        <span className={css.value}>{distDisplay.toFixed(1)} {distLabel(units.distance)}</span>
      </span>
      <span className={css.item}>
        <span className={css.label}>TRUE</span>
        <span className={css.value}>{fmtBrg(trueBrg)}</span>
      </span>
      <span className={css.item}>
        <span className={css.label}>MAG</span>
        <span className={css.value}>{fmtBrg(magBrg)}</span>
      </span>
      {eteHours != null && (
        <span className={css.item}>
          <span className={css.label}>ETE</span>
          <span className={css.value}>{fmtTime(eteHours)}</span>
        </span>
      )}
      {fuelL != null && (
        <span className={css.item}>
          <span className={css.label}>FUEL</span>
          <span className={css.value}>{Math.round(fuelL)} L</span>
        </span>
      )}
      <button className={css.clearBtn} onClick={onClear}>Clear</button>
    </div>
  )
}
