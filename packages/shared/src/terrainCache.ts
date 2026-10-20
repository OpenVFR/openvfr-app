/**
 * One terrain fetch per route, shared by every consumer (Virtual Radar chart,
 * pre-flight warnings, per-leg MSA, auto cruise level).
 *
 * Each of them used to call fetchTerrainProfile() for the same route. On web
 * the service worker deduplicated the identical GET, on native nothing did, so
 * every route edit asked the shared elevation API (OpenTopoData, 1 000
 * calls/day) several times.
 *
 * - Same route (waypoints rounded to 4 decimals) + same base URL = same promise.
 * - Finished routes stay for a short while (a few entries), so a component that
 *   mounts later reuses the result instead of fetching again.
 * - Cancelling is reference counted: the network request is only aborted when
 *   every consumer that asked for it has aborted (dragging a waypoint fires many
 *   requests; the stale ones are cancelled as before).
 * - A failed fetch is not cached.
 * - The cached array is shared: callers must not mutate it.
 */

import { fetchTerrainProfile, type TerrainPoint } from './virtualRadarCalc'
import type { ElevationLookup } from './terrainDem'
import type { RouteWaypoint } from './types'

const MAX_ENTRIES = 6
const TTL_MS = 10 * 60 * 1000

type Entry = {
  promise: Promise<TerrainPoint[]>
  controller: AbortController
  refs: number
  settled: boolean
  at: number
}

const cache = new Map<string, Entry>()

export function terrainRouteKey(waypoints: readonly RouteWaypoint[], baseUrl = ''): string {
  return baseUrl + '|' + waypoints.map((w) => `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`).join('|')
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}

function evict(): void {
  const now = Date.now()
  for (const [k, e] of cache) if (e.settled && now - e.at > TTL_MS) cache.delete(k)
  while (cache.size > MAX_ENTRIES) {
    const oldest = [...cache.entries()].filter(([, e]) => e.settled).sort((a, b) => a[1].at - b[1].at)[0]
    if (!oldest) break
    cache.delete(oldest[0])
  }
}

/** Same contract as fetchTerrainProfile, but shared and cached per route. */
export function fetchTerrainProfileShared(
  waypoints: RouteWaypoint[],
  baseUrl = '',
  signal?: AbortSignal,
  fallback?: ElevationLookup | null,
): Promise<TerrainPoint[]> {
  if (waypoints.length < 2) return Promise.resolve([])
  if (signal?.aborted) return Promise.reject(abortError())

  const key = terrainRouteKey(waypoints, baseUrl)
  let entry = cache.get(key)
  if (!entry) {
    const controller = new AbortController()
    const e: Entry = { promise: undefined as unknown as Promise<TerrainPoint[]>, controller, refs: 0, settled: false, at: Date.now() }
    e.promise = fetchTerrainProfile(waypoints, baseUrl, controller.signal, fallback)
      .then((pts) => { e.settled = true; e.at = Date.now(); evict(); return pts })
      .catch((err) => { if (cache.get(key) === e) cache.delete(key); throw err })
    cache.set(key, e)
    entry = e
  }

  const e = entry
  e.refs++
  return new Promise<TerrainPoint[]>((resolve, reject) => {
    let done = false
    const release = () => {
      if (done) return
      done = true
      e.refs--
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      if (done) return
      release()
      // Nobody is waiting for it any more: stop the request and forget it.
      if (e.refs <= 0 && !e.settled) {
        e.controller.abort()
        if (cache.get(key) === e) cache.delete(key)
      }
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort)
    e.promise.then(
      (pts) => { if (!done) { release(); resolve(pts) } },
      (err) => { if (!done) { release(); reject(err) } },
    )
  })
}

/** Drop everything (tests, or after the elevation source changes). */
export function clearTerrainCache(): void {
  for (const e of cache.values()) if (!e.settled) e.controller.abort()
  cache.clear()
}
