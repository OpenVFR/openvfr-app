import css from './RulerPanel.module.css'
import type { RouteWaypoint } from '../utils/routeCalc'
import { bearingDeg, distanceNm, magneticBearingDeg } from '../utils/routeCalc'
import type { Units } from '../utils/units'
import type { AircraftProfileDocType } from '../db/index'
import { nmToDisplay, distLabel } from '../utils/units'

interface Props {
  from: RouteWaypoint
  to: RouteWaypoint
  units: Units
  aircraftProfile?: AircraftProfileDocType
  onClear: () => void
}

/** Format a coordinate as degrees + decimal minutes (DMM). */
function dmmStr(v: number, isLat: boolean): string {
  const abs = Math.abs(v)
  const deg = Math.floor(abs)
  const min = ((abs - deg) * 60).toFixed(3)
  const dir = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W')
  return `${deg}°${min}${dir}`
}

function fmtBrg(deg: number): string {
  return `${Math.round(deg).toString().padStart(3, '0')}°`
}

function fmtTime(hours: number): string {
  const totalMin = Math.round(hours * 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `${m} min`
  return `${h}h ${m}m`
}

export default function RulerPanel({ from, to, units, aircraftProfile, onClear }: Props) {
  const distNm       = distanceNm(from, to)
  const distDisplay  = nmToDisplay(distNm, units.distance)
  const trueBrg      = bearingDeg(from, to)
  const magBrg       = magneticBearingDeg(from, to)
  const cruiseKts    = aircraftProfile?.cruiseIas ?? null
  const eteHours     = cruiseKts && cruiseKts > 0 ? distNm / cruiseKts : null
  const fuelL        = eteHours != null && aircraftProfile
    ? eteHours * aircraftProfile.fuelBurnLhr
    : null

  return (
    <div className={css.panel}>
      {/* Endpoints */}
      <div className={css.points}>
        <div className={css.point}>
          <span className={css.ptLabel}>A</span>
          <span className={css.ptCoord}>
            {from.name ? `${from.name} — ` : ''}{dmmStr(from.lat, true)} {dmmStr(from.lng, false)}
          </span>
        </div>
        <div className={css.point}>
          <span className={css.ptLabel}>B</span>
          <span className={css.ptCoord}>
            {to.name ? `${to.name} — ` : ''}{dmmStr(to.lat, true)} {dmmStr(to.lng, false)}
          </span>
        </div>
      </div>

      {/* Measurements */}
      <div className={css.measurements}>
        <div className={css.mRow}>
          <span className={css.mLabel}>Distance</span>
          <span className={css.mValue}>{distDisplay.toFixed(1)} {distLabel(units.distance)}</span>
        </div>
        <div className={css.mRow}>
          <span className={css.mLabel}>True track</span>
          <span className={css.mValue}>{fmtBrg(trueBrg)}</span>
        </div>
        <div className={css.mRow}>
          <span className={css.mLabel}>Mag track</span>
          <span className={css.mValue}>{fmtBrg(magBrg)}</span>
        </div>
        {eteHours != null && (
          <div className={css.mRow}>
            <span className={css.mLabel}>ETE ({cruiseKts} kt)</span>
            <span className={css.mValue}>{fmtTime(eteHours)}</span>
          </div>
        )}
        {fuelL != null && (
          <div className={css.mRow}>
            <span className={css.mLabel}>Fuel (est.)</span>
            <span className={css.mValue}>{fuelL.toFixed(1)} L</span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className={css.footer}>
        <button className={css.clearBtn} onClick={onClear}>Clear Ruler</button>
        <span className={css.hint}>Click map: first = A, second = B</span>
      </div>
    </div>
  )
}
