/**
 * useVicinityAerodromes — web counterpart to native's own
 * useVicinityAerodromes.ts (apps/native/src/hooks/useVicinityAerodromes.ts).
 * Backs VicinityBriefPanel's aerodrome picker with the SAME priority order
 * as native, kept in sync deliberately -- see that file's doc comment for
 * the full rationale:
 *
 *  1. Route marked Active (routeVisible) + route planned -> aerodromes near
 *     the planned route (same lateral-buffer match as useWeatherAlongRoute.ts),
 *     ordered by distance from the route.
 *  2. Otherwise -> nearest aerodromes to the current/last-known GPS position
 *     within RADIUS_NM.
 *  3. No GPS fix / nothing within RADIUS_NM and no active route -> falls
 *     back to the settings-page home airfield, resolved to a single-entry
 *     list at distNm:0, so the picker still opens on a real aerodrome
 *     instead of an empty state.
 *
 * Reuses useAirfieldBrief.ts's own `loadAerodromes()` module-level cache
 * (already parses the full AerodromeFeatureProps shape, frequencies
 * included) rather than adding yet another se-aerodromes.geojson parser.
 */

import { useEffect, useState } from 'react'
import type { RouteWaypoint } from '../utils/routeCalc'
import { nearestRoutePoint } from '@open-vfr/shared/notamRouteFilter'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import type { GpsPosition } from '../utils/gpsTypes'
import { loadAerodromes, type FullAerodrome } from './useAirfieldBrief'
import { useActiveCountries } from '../utils/countryData'
import type { AerodromeFeatureProps } from '../components/AerodromePopup'

const RADIUS_NM       = 25   // matches native's useVicinityAerodromes.ts
const ROUTE_BUFFER_NM = 15   // matches useWeatherAlongRoute.ts
const MAX_AERODROMES  = 15

export interface VicinityAerodrome {
  icao:   string
  name:   string
  lat:    number
  lng:    number
  distNm: number
  props:  AerodromeFeatureProps
}

interface Opts {
  waypoints:    RouteWaypoint[]
  position:     GpsPosition | null
  /** RouteContext's own Active/Inactive toggle -- see doc comment above. */
  routeVisible: boolean
  /** Settings-page home airfield ICAO -- last-resort fallback. */
  homeIcao?:    string | null
}

function toVicinity(a: FullAerodrome, distNm: number): VicinityAerodrome {
  return { icao: a.props.icao, name: a.props.name, lat: a.lat, lng: a.lng, distNm, props: a.props }
}

export function useVicinityAerodromes({ waypoints, position, routeVisible, homeIcao }: Opts): VicinityAerodrome[] {
  const [all, setAll] = useState<FullAerodrome[]>([])

  const { key: countriesKey } = useActiveCountries()
  useEffect(() => { loadAerodromes().then(setAll) }, [countriesKey])

  const useRoute = routeVisible && waypoints.length > 0

  if (all.length === 0) return []

  if (useRoute) {
    // Sorted by along-route position (flight sequence, departure ->
    // destination), NOT by lateral/cross-track distance -- two aerodromes
    // can sit equally close to the route line while being at opposite
    // ends of it, and "closest first" then reads as a scrambled, seemingly
    // random order to a pilot expecting "in the order I'll pass them".
    // `distNm` itself keeps its existing lateral-distance meaning (still
    // shown in the picker pill as "how close to the route"), only the sort
    // key changes.
    return all
      .map((a) => {
        const pos = nearestRoutePoint({ lat: a.lat, lng: a.lng }, waypoints)
        return { ...toVicinity(a, pos.lateralNm), alongNm: pos.alongNm }
      })
      .filter((a) => a.distNm <= ROUTE_BUFFER_NM)
      .sort((a, b) => a.alongNm - b.alongNm)
      .slice(0, MAX_AERODROMES)
  }

  if (position) {
    const nearby = all
      .map((a) => toVicinity(a, distanceNm({ lat: position.lat, lng: position.lng }, { lat: a.lat, lng: a.lng })))
      .filter((a) => a.distNm <= RADIUS_NM)
      .sort((a, b) => a.distNm - b.distNm)
      .slice(0, MAX_AERODROMES)
    if (nearby.length > 0) return nearby
  }

  if (homeIcao) {
    const home = all.find((a) => a.props.icao === homeIcao)
    if (home) return [toVicinity(home, 0)]
  }

  return []
}
