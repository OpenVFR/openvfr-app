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

    async function run() {
      ac?.abort()
      ac = new AbortController()
      const b = map!.getBounds()
      try {
        const points = await fetchWindGrid(
          { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() },
          altFt,
          { baseUrl: API_BASE_URL, signal: ac.signal },
        )
        if (cancelled) return
        setFc({
          type: 'FeatureCollection',
          features: points.map((p) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
            properties: { dirDeg: p.dirDeg, speedKts: p.speedKts },
          })),
        })
      } catch {
        // Network hiccup — leave the last-good arrows in place rather than
        // clearing the overlay for a transient failure.
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
