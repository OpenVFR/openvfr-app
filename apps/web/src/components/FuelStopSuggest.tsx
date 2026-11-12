/**
 * "Suggest fuel stop" for a route the tanks cannot cover: runs the shared
 * fuel-stop search over the loaded aerodromes and lets the pilot add a plan's
 * stops to the route (one undo step). Nothing runs until the pilot asks.
 */
import { useEffect, useState } from 'react'
import { loadCountryGeojson } from '@open-vfr/shared/countryData'
import { parseAerodromesGeoJson, aerodromeToWaypoint, type AerodromeFeatureCollectionLike } from '@open-vfr/shared/findDestination'
import { suggestFuelStops, type FuelStopResult, type FuelStopPlan } from '@open-vfr/shared/fuelStops'
import { FUEL_LABELS, preferenceLabel } from '@open-vfr/shared/fuelTypes'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { LegOverride, AircraftProfileDocType } from '../db/index'
import css from './FuelStopSuggest.module.css'

interface Props {
  waypoints:    RouteWaypoint[]
  legOverrides: LegOverride[]
  aircraft:     AircraftProfileDocType
  legWinds?:    ({ dirDeg: number; speedKts: number } | null)[]
  onInsertInRoute: (wp: RouteWaypoint, afterIdx: number) => void
  /** Marks an existing route point as a fuel stop (an aerodrome the route already passes). */
  onSetFuelStop: (wpIdx: number, on: boolean) => void
}

function fmtTime(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  return h > 0 ? `${h}h ${m.toString().padStart(2, '0')}` : `${m} min`
}

export default function FuelStopSuggest({ waypoints, legOverrides, aircraft, legWinds, onInsertInRoute, onSetFuelStop }: Props) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<FuelStopResult | null>(null)

  // A route or aircraft change makes the suggestions stale.
  useEffect(() => { setResult(null); setState('idle') }, [waypoints, legOverrides, aircraft])

  async function run() {
    setState('busy')
    try {
      const fc = await loadCountryGeojson('aerodromes')
      const aerodromes = parseAerodromesGeoJson(fc as unknown as AerodromeFeatureCollectionLike)
      setResult(suggestFuelStops(waypoints, legOverrides, aircraft, aerodromes, legWinds))
      setState('done')
    } catch (err) {
      console.error(err)
      setState('error')
    }
  }

  function addPlan(plan: FuelStopPlan) {
    // Last stop first, so earlier insert positions stay valid; stops on the
    // same leg end up in route order. Back-to-back inserts are one undo step.
    for (const s of [...plan.stops].reverse()) {
      if (s.waypointIndex !== undefined) onSetFuelStop(s.waypointIndex, true)
      else onInsertInRoute({ ...aerodromeToWaypoint(s.aerodrome), fuelStop: true }, s.insertAfter)
    }
    setResult(null)
    setState('idle')
  }

  if (state !== 'done' || !result) {
    return (
      <div className={css.box}>
        <button type="button" className={css.btn} disabled={state === 'busy'} onClick={run}>
          {state === 'busy' ? 'Searching…' : 'Suggest fuel stop'}
        </button>
        {state === 'error' && <p className={css.error}>Could not load aerodrome data. Try again.</p>}
      </div>
    )
  }

  return (
    <div className={css.box} role="region" aria-label="Fuel stop suggestions">
      {result.status === 'not-needed' && <p className={css.note}>No fuel stop needed.</p>}
      {result.status === 'missing-profile-data' && (
        <p className={css.note}>Set cruise speed, fuel burn and usable fuel in the aircraft profile first.</p>
      )}
      {result.status === 'none-found' && (
        <p className={css.note}>
          No aerodrome near the route fits: {result.candidates === 0
            ? 'none sells a matching fuel with an acceptable runway within 25 NM of the route.'
            : 'none splits the route into hops the tanks can cover.'} Check the aircraft&apos;s fuel types and runway limits, or add a stop by hand.
        </p>
      )}
      {result.status === 'found' && (
        <>
          {result.fuelTypesUnset && (
            <p className={css.note}>The aircraft has no fuel types set: these aerodromes list some fuel, not necessarily yours.</p>
          )}
          <ol className={css.plans}>
            {result.plans.map((plan, i) => (
              <li key={i} className={css.plan}>
                {plan.stops.map(s => (
                  <div key={s.aerodrome.icao} className={css.stop}>
                    <span className={css.icao}>{s.aerodrome.icao}</span>
                    <span className={css.name}>{s.aerodrome.name}</span>
                    <span className={css.meta}>
                      {s.fuels.length > 0 ? s.fuels.map(f => FUEL_LABELS[f]).join(', ') : s.aerodrome.fuel.join(', ')}
                      {s.fuels.length > 0 && s.fuelRank > 0 && <span className={css.ppr}> ({preferenceLabel(s.fuelRank)} choice)</span>}
                      {' · '}{s.aerodrome.maxRunwayM > 0 ? `${s.aerodrome.maxRunwayM} m` : 'runway ?'}
                      {s.aerodrome.surfaces.length > 0 ? ` ${s.aerodrome.surfaces.join('/')}` : ''}
                      {' · '}{s.waypointIndex !== undefined ? 'on your route' : s.detourNm < 1 ? 'on track' : `+${s.detourNm.toFixed(0)} NM`}
                      {s.aerodrome.ppr && <span className={css.ppr}> · PPR</span>}
                    </span>
                  </div>
                ))}
                <div className={css.hops}>
                  {plan.hops.map((h, k) => (
                    <span key={k}>{h.from}→{h.to} {fmtTime(h.enrouteMins)}, {h.landingFuelL.toFixed(0)} L left</span>
                  ))}
                </div>
                <div className={css.planFoot}>
                  <span className={css.meta}>
                    {plan.stops.length} stop{plan.stops.length > 1 ? 's' : ''} · +{Math.round(plan.extraMins)} min flying
                  </span>
                  <button type="button" className={css.btnPrimary} onClick={() => addPlan(plan)}>Add to route</button>
                </div>
              </li>
            ))}
          </ol>
          <p className={css.caveat}>Fuel listings come from published aerodrome data and can be out of date. Check the AIP, opening hours and NOTAMs, or call ahead.</p>
        </>
      )}
      <button type="button" className={css.btnLink} onClick={() => { setResult(null); setState('idle') }}>Close</button>
    </div>
  )
}
