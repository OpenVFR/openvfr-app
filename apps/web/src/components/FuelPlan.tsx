import { useMemo } from 'react'
import { computeTripFuelPlans, type FuelPlan as FuelPlanData } from '../utils/fuelCalc'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { LegOverride, AircraftProfileDocType } from '../db/index'
import css from './FuelPlan.module.css'
import FuelStopSuggest from './FuelStopSuggest'

interface Props {
  waypoints:    RouteWaypoint[]
  legOverrides: LegOverride[]
  aircraft:     AircraftProfileDocType
  /** Effective wind per leg (override > global > forecast). */
  legWinds?:    ({ dirDeg: number; speedKts: number } | null)[]
  /** Insert a route point after index `afterIdx`; enables fuel-stop suggestions when the fuel is short. */
  onInsertInRoute?: (wp: RouteWaypoint, afterIdx: number) => void
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

/** One hop's fuel table and margin. */
function PlanTable({ plan }: { plan: FuelPlanData }) {
  const margin = plan.availableFuelL > 0
    ? plan.availableFuelL - plan.totalMinFuelL
    : null
  return (
    <>
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
            <td className={css.label}>Diversion ({plan.diversionMin} min)</td>
            <td className={css.value}>{fmt(plan.diversionFuelL)}</td>
          </tr>

          <tr>
            <td className={css.label}>Landing reserve</td>
            <td className={css.value}>{fmt(plan.landingFuelL)}</td>
          </tr>

          {plan.finalReserveMin > 0 && (
            <tr>
              <td className={css.label}>Final reserve ({plan.finalReserveMin} min)</td>
              <td className={css.value}>{fmt(plan.finalReserveFuelL)}</td>
            </tr>
          )}
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
          {plan.unusableFuelL > 0 && (
            <tr>
              <td className={css.labelSub}>Unusable (not in available)</td>
              <td className={css.valueSub}>{fmt(plan.unusableFuelL)}</td>
            </tr>
          )}
        </tfoot>
      </table>

      {margin !== null && (
        <div className={margin >= 0 ? css.statusOk : css.statusShort}>
          {margin >= 0
            ? `✓ Margin ${fmt(margin)}`
            : `✗ Short ${fmt(-margin)}`}
        </div>
      )}
    </>
  )
}

export default function FuelPlan({ waypoints, legOverrides, aircraft, legWinds, onInsertInRoute }: Props) {
  // One hop per take-off: the route splits at points marked as fuel stops.
  const hops = useMemo(
    () => computeTripFuelPlans(waypoints, legOverrides, aircraft, legWinds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [waypoints, legOverrides, aircraft, legWinds],
  )

  const hasSpeed = aircraft.cruiseIas > 0 ||
    legOverrides.some((o) => (o.speedKts ?? 0) > 0)

  const short = hops.some(h => h.plan.availableFuelL > 0 && h.plan.totalMinFuelL > h.plan.availableFuelL)
  const pointName = (i: number) => waypoints[i]?.name || `WP${i + 1}`

  return (
    <div className={css.panel}>
      {!hasSpeed && (
        <p className={css.hint}>
          Set cruise speed in the aircraft profile or per-leg to compute fuel burn.
        </p>
      )}

      {hops.length <= 1
        ? hops[0] && <PlanTable plan={hops[0].plan} />
        : hops.map((h, k) => (
            <section key={`${h.fromIdx}-${h.toIdx}`} className={css.hop} aria-label={`Hop ${k + 1}`}>
              <div className={css.hopTitle}>
                Hop {k + 1}: {pointName(h.fromIdx)} → {pointName(h.toIdx)}
                {h.toIdx < waypoints.length - 1 && <span className={css.hopStop}> · refuel</span>}
              </div>
              <PlanTable plan={h.plan} />
            </section>
          ))}

      {short && onInsertInRoute && (
        <FuelStopSuggest
          waypoints={waypoints}
          legOverrides={legOverrides}
          aircraft={aircraft}
          legWinds={legWinds}
          onInsertInRoute={onInsertInRoute}
        />
      )}
    </div>
  )
}
