/**
 * useWindGrid (native) — feeds the ambient wind-barb overlay's GeoJSON
 * source, mirroring apps/web/src/hooks/useWindGrid.ts. Native has no
 * direct `map.getBounds()` escape hatch exposed by
 * @maplibre/maplibre-react-native's MapView ref the way web's maplibre-gl
 * JS Map does, so the viewport bounding box is approximated from the
 * camera's center/zoom (reported by AviationMap's onRegionDidChange) using
 * standard Web Mercator tile math — accurate enough for a coarse
 * wind-sample lattice (this only needs to roughly cover what's on screen, not
 * pixel-perfect edges).
 */

import { useEffect, useRef, useState } from 'react'
import { Dimensions } from 'react-native'
import type { FeatureCollection } from 'geojson'
import { fetchWindGrid, cachedWindGrid, type WindGridPoint } from '@open-vfr/shared/windGrid'
import { API_BASE } from '../config'

const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] }
const DEBOUNCE_MS = 400

function toFc(points: WindGridPoint[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: { dirDeg: p.dirDeg, speedKts: p.speedKts },
    })),
  }
}

export interface CamState {
  lat: number
  lng: number
  zoom: number
}

/** Approximate viewport lat/lng bounds from center+zoom (Web Mercator, 256px tiles). */
function approxBounds(cam: CamState) {
  const { width, height } = Dimensions.get('window')
  const degPerTileLng = 360 / Math.pow(2, cam.zoom)
  const lngSpan = (width / 256) * degPerTileLng
  // Latitude span approximated the same way near the current latitude
  // (good enough at typical VFR map zooms/latitudes — not used near poles).
  const latRad = (cam.lat * Math.PI) / 180
  const metersPerDegLat = 111320
  const metersPerPixel = (156543.03392 * Math.cos(latRad)) / Math.pow(2, cam.zoom)
  const latSpan = (height * metersPerPixel) / metersPerDegLat
  return {
    west: cam.lng - lngSpan / 2,
    east: cam.lng + lngSpan / 2,
    south: cam.lat - latSpan / 2,
    north: cam.lat + latSpan / 2,
  }
}

export function useWindGrid(cam: CamState | null, enabled: boolean, altFt: number | null): FeatureCollection {
  const [fc, setFc] = useState<FeatureCollection>(EMPTY_FC)
  const lastFetchKeyRef = useRef<string>('')

  useEffect(() => {
    if (!enabled || !cam) {
      setFc(EMPTY_FC)
      lastFetchKeyRef.current = ''
      return
    }

    // Debounce keyed on a rounded camera snapshot — camState updates on
    // every pan/zoom frame (onRegionIsChanging), so a plain effect-per-
    // render would refetch constantly. Round enough to dedupe near-
    // identical positions without missing genuine viewport moves.
    const key = `${cam.lat.toFixed(2)},${cam.lng.toFixed(2)},${cam.zoom.toFixed(1)}`
    if (key === lastFetchKeyRef.current) return

    let cancelled = false
    const timer = setTimeout(() => {
      lastFetchKeyRef.current = key
      const bounds = approxBounds(cam)
      // Cached points first (also drops the previous zoom tier at once), then the missing ones.
      setFc(toFc(cachedWindGrid(bounds, altFt)))
      fetchWindGrid(bounds, altFt, { baseUrl: API_BASE })
        .then((points) => {
          if (cancelled) return
          setFc(toFc(points))
        })
        .catch((err: unknown) => {
          if (cancelled) return
          // Logged (unlike a bare no-op) because a *persistently* broken
          // fetch here (e.g. a backend proxy regression) otherwise looks
          // identical to "no wind data available for this area" from the
          // UI alone -- see docker/nginx.prod.conf's /api/open-meteo/
          // location comments for the exact regression this masked on
          // 2026-09-13. Mirrors web's useWindGrid.ts.
          console.warn('[useWindGrid] wind fetch failed:', err)
        })
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [cam, enabled, altFt])

  return fc
}
