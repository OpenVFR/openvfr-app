/**
 * src/hooks/useWindGrid.ts
 *
 * Feeds the 'wind-grid' MapLibre source for the ambient wind-arrows overlay
 * (LAYER_GROUPS 'wind') — samples a coarse grid of Open-Meteo wind readings
 * across the current viewport via @open-vfr/shared/windGrid, refetching on
 * `moveend` (debounced) while the layer is enabled. No-ops entirely when
 * disabled, so panning/zooming costs nothing unless the user opted in.
 */

import { useEffect, useState } from 'react'
import type * as maplibregl from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import { fetchWindGrid } from '@open-vfr/shared/windGrid'
import { API_BASE_URL } from '../utils/env'

const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] }
const DEBOUNCE_MS = 600

export function useWindGrid(
  map: maplibregl.Map | null,
  enabled: boolean,
  altFt: number | null,
): FeatureCollection {
  const [fc, setFc] = useState<FeatureCollection>(EMPTY_FC)

  useEffect(() => {
    if (!map || !enabled) {
      setFc(EMPTY_FC)
      return
    }

    let cancelled = false
    let ac: AbortController | null = null
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    // Bumped on every run() call, captured per-run below -- guards against
    // a superseded run's *result* still landing after a newer one already
    // committed. `ac?.abort()` only cancels the underlying fetches; it does
    // NOT stop an in-flight run's own `.then` from executing with whatever
    // subset of points happened to fulfil before the abort took effect (a
    // rapid pan/zoom fires several debounced runs in quick succession).
    // Without this, that stale partial result would still call setFc and
    // briefly replace a full grid with a sparse one, self-correcting only
    // once the latest run finishes -- exactly the "barb count looks random
    // while zooming" bug reported in a pre-release pass.
    let generation = 0

    async function run() {
      ac?.abort()
      ac = new AbortController()
      const myGeneration = ++generation
      const b = map!.getBounds()
      try {
        const points = await fetchWindGrid(
          { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() },
          altFt,
          { baseUrl: API_BASE_URL, signal: ac.signal },
        )
        if (cancelled || myGeneration !== generation) return
        setFc({
          type: 'FeatureCollection',
          features: points.map((p) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
            properties: { dirDeg: p.dirDeg, speedKts: p.speedKts },
          })),
        })
      } catch (err) {
        if (cancelled || (err as { name?: string }).name === 'AbortError') return
        // Network hiccup -- leave the last-good arrows in place rather than
        // clearing the overlay for a transient failure. Logged (unlike a
        // bare no-op) because a *persistently* broken fetch here (e.g. a
        // backend proxy regression) otherwise looks identical to "no wind
        // data available for this area" from the UI alone -- see
        // docker/nginx.prod.conf's /api/open-meteo/ location comments for
        // the exact regression this masked on 2026-09-13.
        console.warn('[useWindGrid] wind fetch failed:', err)
      }
    }

    function scheduleRun() {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(run, DEBOUNCE_MS)
    }

    run()
    map.on('moveend', scheduleRun)

    return () => {
      cancelled = true
      ac?.abort()
      if (debounceTimer) clearTimeout(debounceTimer)
      map.off('moveend', scheduleRun)
    }
  }, [map, enabled, altFt])

  return fc
}
