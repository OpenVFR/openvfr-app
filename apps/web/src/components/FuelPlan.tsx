import { useMemo } from 'react'
import { computeFuelPlan } from '../utils/fuelCalc'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { LegOverride, AircraftProfileDocType } from '../db/index'
import css from './FuelPlan.module.css'

interface Props {
  waypoints:    RouteWaypoint[]
  legOverrides: LegOverride[]
  aircraft:     AircraftProfileDocType
}

function fmt(l: number): string {
  return `${l.toFixed(1)} L`
}

function fmtTime(mins: number): string {
  if (mins <= 0) return '0 min'
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  if (h === 0) return `${m} min`
  return `${h}h ${m.toString().padStart(2, '0')}min`
}

export default function FuelPlan({ waypoints, legOverrides, aircraft }: Props) {
  const plan = useMemo(
    () => computeFuelPlan(waypoints, legOverrides, aircraft),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [waypoints, legOverrides, aircraft],
  )

  const hasSpeed = aircraft.cruiseIas > 0 ||
    legOverrides.some((o) => (o.speedKts ?? 0) > 0)

  const margin = plan.availableFuelL > 0
    ? plan.availableFuelL - plan.totalMinFuelL
    : null

  return (
    <div className={css.panel}>
      {!hasSpeed && (
        <p className={css.hint}>
          Set cruise speed in the aircraft profile or per-leg to compute fuel burn.
        </p>
      )}

      <table className={css.table}>
        <tbody>
          <tr>
            <td className={css.label}>Taxi/Start</td>
            <td className={css.value}>{fmt(plan.taxiFuelL)}</td>
          </tr>

          <tr>
            <td className={css.label}>
              Enroute{plan.enrouteMins > 0 ? ` (${fmtTime(plan.enrouteMins)})` : ''}
            </td>
            <td className={css.value}>{fmt(plan.enrouteFuelL)}</td>
          </tr>

          {plan.climbMins > 0 && (
            <tr>
              <td className={css.labelSub}>Climb ({fmtTime(plan.climbMins)})</td>
              <td className={css.valueSub}>{fmt(plan.climbFuelL)}</td>
            </tr>
          )}

          {plan.cruiseMins > 0 && (
            <tr>
              <td className={css.labelSub}>Cruise ({fmtTime(plan.cruiseMins)})</td>
              <td className={css.valueSub}>{fmt(plan.cruiseFuelL)}</td>
            </tr>
          )}

          {plan.descentMins > 0 && (
            <tr>
              <td className={css.labelSub}>Descent ({fmtTime(plan.descentMins)})</td>
              <td className={css.valueSub}>{fmt(plan.descentFuelL)}</td>
            </tr>
          )}

          <tr>
            <td className={css.label}>Contingency ({plan.contingencyPct}%)</td>
            <td className={css.value}>{fmt(plan.contingencyFuelL)}</td>
          </tr>

          <tr>
            <td className={css.label}>Holding ({plan.holdingMin} min)</td>
            <td className={css.value}>{fmt(plan.holdingFuelL)}</td>
          </tr>

          <tr>
            <td className={css.label}>Diversion (30 min)</td>
            <td className={css.value}>{fmt(plan.diversionFuelL)}</td>
          </tr>

          <tr>
            <td className={css.label}>Landing reserve</td>
            <td className={css.value}>{fmt(plan.landingFuelL)}</td>
          </tr>
        </tbody>

        <tfoot>
          <tr className={css.rowTotal}>
            <td className={css.label}>Min required</td>
            <td className={css.value}>{fmt(plan.totalMinFuelL)}</td>
          </tr>
          <tr>
            <td className={css.label}>Available</td>
            <td className={css.value}>
              {plan.availableFuelL > 0 ? fmt(plan.availableFuelL) : '—'}
            </td>
          </tr>
        </tfoot>
      </table>

      {margin !== null && (
        <div className={margin >= 0 ? css.statusOk : css.statusShort}>
          {margin >= 0
            ? `✓ Margin ${fmt(margin)}`
            : `✗ Short ${fmt(-margin)}`}
        </div>
      )}
    </div>
  )
}
