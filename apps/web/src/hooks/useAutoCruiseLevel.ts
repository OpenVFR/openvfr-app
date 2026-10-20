/**
 * useAutoCruiseLevel — gives a newly appended/inserted route leg a safe
 * altitude. Mirrors the native hook of the same name.
 *
 * On every waypoint change that is a single append/insert
 * (@open-vfr/shared/autoCruiseLevel newLegsAfterChange), the terrain under
 * each new leg and the obstacles in its corridor are looked up. If the leg's
 * planned altitude (its override, else the aircraft cruise altitude) is
 * below the required level, the override is raised and `onNotice` is
 * called with a one-line explanation. Legs the user already levelled, or
 * whose endpoints merely moved, are never changed.
 */

import { useEffect, useRef } from 'react'
import { buildVirtualRadarProfile, terrainAt, terrainForMsa } from '@open-vfr/shared/virtualRadarCalc'
import { fetchTerrainProfileShared } from '@open-vfr/shared/terrainCache'
import { useMefGrids } from './useMefGrids'
import { requiredLegAltFt, newLegsAfterChange, autoLevelMessage } from '@open-vfr/shared/autoCruiseLevel'
import { loadCountryGeojson } from '@open-vfr/shared/countryData'
import { getRemoteDem } from '../utils/terrainDem'
import { getMsaMargins } from '../db/useSettings'
import { resolveMsaMargins } from '@open-vfr/shared/msaMargins'
import { obstacleTipsForMsa } from '@open-vfr/shared/obstacleHeights'
import { API_BASE_URL } from '../utils/env'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { LegOverride } from '../db/index'

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

export function useAutoCruiseLevel(opts: {
  waypoints: RouteWaypoint[]
  legOverrides: LegOverride[]
  setLegOverrides: (fn: (prev: LegOverride[]) => LegOverride[]) => void
  /** Planned altitude for legs without an override. */
  defaultAltFt: number
  onNotice: (text: string) => void
  /** Off while flying: the route is being followed, not planned. */
  enabled: boolean
}) {
  const { waypoints, legOverrides, setLegOverrides, defaultAltFt, onNotice, enabled } = opts
  const prevRef = useRef<RouteWaypoint[]>(waypoints)
  const mefGrids = useMefGrids()
  // Latest values for the async work below.
  const latest = useRef({ waypoints, legOverrides, defaultAltFt, onNotice, setLegOverrides, mefGrids })
  latest.current = { waypoints, legOverrides, defaultAltFt, onNotice, setLegOverrides, mefGrids }

  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = waypoints
    if (!enabled) return
    const legs = newLegsAfterChange(prev, waypoints)
    if (legs.length === 0) return
    for (const legIndex of legs) {
      const legWps = [waypoints[legIndex], waypoints[legIndex + 1]]
      Promise.all([
        fetchTerrainProfileShared(legWps, API_BASE_URL, undefined, getRemoteDem()).catch(() => []),
        loadCountryGeojson('obstacles').catch(() => EMPTY_FC),
        loadCountryGeojson('landmarks').catch(() => EMPTY_FC),
      ]).then(([terrain, obstacles, landmarks]) => {
        // Stale if the leg's endpoints changed while the lookup ran (or the
        // route went away).
        const now = latest.current.waypoints
        const same = (a?: RouteWaypoint, b?: RouteWaypoint) => !!a && !!b && a.lat === b.lat && a.lng === b.lng
        if (!same(now[legIndex], legWps[0]) || !same(now[legIndex + 1], legWps[1])) return
        const profile = buildVirtualRadarProfile(legWps, [], EMPTY_FC, obstacles, undefined, landmarks, Infinity, undefined, { obstacleNm: resolveMsaMargins(getMsaMargins()).abeamNm, landmarkNm: resolveMsaMargins(getMsaMargins()).abeamNm })
        // Fetched terrain, or (fetch failed) route samples from the terrain grid.
        const tt = terrainForMsa(legWps, terrain, latest.current.mefGrids, getMsaMargins(), true)
        const tips = obstacleTipsForMsa(profile.obstacles, profile.landmarks, (d) => terrainAt(tt.pts, d)).map((o) => o.elevationFt)
        // Corridor maximum (offline grid) as well as the centreline, like the chart's MSA.
        const elev = tt.pts.map((p, i) => Math.max(p.elevFt, tt.corridorFt[i] ?? 0))
        const required = requiredLegAltFt(elev, tips, getMsaMargins())
        const { legOverrides, defaultAltFt, onNotice, setLegOverrides } = latest.current
        const planned = legOverrides[legIndex]?.altFt ?? defaultAltFt
        if (required <= planned) return
        setLegOverrides((prev) => {
          const next = [...prev]
          next[legIndex] = { ...(next[legIndex] ?? {}), altFt: required }
          return next
        })
        const name = (i: number) => now[i]?.name ?? `WP${i + 1}`
        onNotice(autoLevelMessage(name(legIndex), name(legIndex + 1), required))
      }).catch(() => { /* lookup failed: leave the leg as planned */ })
    }
  // Only waypoint identity changes matter; the rest is read through `latest`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waypoints, enabled])
}
