/**
 * useRouteWinds — the effective wind on every leg of the route, in one place so
 * the route table, fuel plan and pre-flight check all agree.
 *
 * Per leg: manual leg override → manual global wind → forecast (SkyDemon-style:
 * evaluated at the leg midpoint, altitude and expected time).
 */

import { useMemo } from 'react'
import { iasToTas } from '@open-vfr/shared/airspeed'
import type { WindAloft } from '@open-vfr/shared/fetchWind'
import type { LegOverride } from '../db/index'
import type { GlobalWind } from '../db/useSettings'
import { distanceNm, type RouteWaypoint } from '../utils/routeCalc'
import { useLegForecastWind, type LegWindQuery } from './useLegForecastWind'

export interface RouteWinds {
  /** Effective wind per leg (override → global → forecast); null when none is known. */
  effective: (WindAloft | null)[]
  /** Forecast wind per leg (ignores overrides/global). */
  forecast: (WindAloft | null)[]
  loading: boolean
  error: boolean
  refresh: () => void
}

export function useRouteWinds(
  waypoints: RouteWaypoint[],
  legOverrides: LegOverride[],
  defaultAltFt: number | undefined,
  defaultSpeedKts: number | undefined,
  takeoffTime: Date | null,
  globalWind: GlobalWind | null,
): RouteWinds {
  const queries = useMemo<LegWindQuery[]>(() => {
    const startMs = (takeoffTime ?? new Date()).getTime()
    let cumMin = 0
    const out: LegWindQuery[] = []
    for (let i = 0; i < waypoints.length - 1; i++) {
      const from = waypoints[i], to = waypoints[i + 1]
      const ovr = legOverrides[i] ?? {}
      const alt = ovr.altFt ?? defaultAltFt ?? 3500
      const ias = ovr.speedKts ?? defaultSpeedKts
      const tas = ias && ias > 0 ? iasToTas(ias, alt) : 100
      const legMin = (distanceNm(from, to) / tas) * 60
      out.push({ lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2, altFt: alt, at: new Date(startMs + (cumMin + legMin / 2) * 60_000) })
      cumMin += legMin
    }
    return out
  }, [waypoints, legOverrides, defaultAltFt, defaultSpeedKts, takeoffTime])

  const { winds: forecast, loading, error, refresh } = useLegForecastWind(queries, !globalWind)

  const effective = useMemo(() => queries.map((_, i): WindAloft | null => {
    const o = legOverrides[i]
    if (o?.windDir != null && o?.windSpd != null) return { dirDeg: o.windDir, speedKts: o.windSpd }
    if (globalWind) return { dirDeg: globalWind.dirDeg, speedKts: globalWind.speedKts }
    return forecast[i] ?? null
  }), [queries, legOverrides, globalWind, forecast])

  return { effective, forecast, loading, error, refresh }
}
