/**
 * WeatherAlongRoutePanel — METAR/TAF for every aerodrome near the planned
 * route, in one list. See useWeatherAlongRoute.ts for the collection logic.
 */

import type { RouteWeatherStation } from '../hooks/useWeatherAlongRoute'
import css from './WeatherAlongRoutePanel.module.css'

interface Props {
  stations: RouteWeatherStation[]
}

export default function WeatherAlongRoutePanel({ stations }: Props) {
  if (stations.length === 0) {
    return <div className={css.empty}>No route planned, or no aerodromes nearby</div>
  }

  return (
    <div>
      {stations.map((s) => (
        <div key={s.icao} className={css.item}>
          <div className={css.itemHeader}>
            <span className={css.icao}>{s.icao}</span>
            <span className={css.dist}>{s.distNm} nm</span>
            {s.decoded?.flightRule && (
              <span className={`${css.frBadge} ${css[`fr${s.decoded.flightRule}`]}`}>
                {s.decoded.flightRule}
              </span>
            )}
          </div>
          {s.metar && <div className={css.raw}>{s.metar}</div>}
          {!s.metar && <div className={css.raw}>No METAR available</div>}
        </div>
      ))}
    </div>
  )
}
