/**
 * Placing the base layer's VFR reporting points beside landmark and obstacle symbols on the web map (packages/shared symbolDeclutter does the geometry).
 * `useBaseWaypoints` loads the country's waypoints as data (the true positions); `useBaseWaypointDeclutter` writes the placement into the map's `ofm-waypoints`
 * source (which the map style creates) whenever a point has to move. `renderedSymbolBlockers` and `viewOf` read what the map draws now; the aerodrome details layer
 * uses them too, for the club reporting points.
 */
import { useEffect, useRef, useState } from 'react'
import type * as maplibregl from 'maplibre-gl'
import { displaceWaypoints, landmarkRadius, obstacleRadius, sameDisplacement, type Blocker, type View } from '@open-vfr/shared/symbolDeclutter'
import { loadCountryGeojson } from '@open-vfr/shared/countryData'
import { useActiveCountries } from './countryData'

/** Landmark and obstacle symbols the map draws now (fixed: the reporting points move clear of them). */
export function renderedSymbolBlockers(m: maplibregl.Map): Blocker[] {
  const layers = ['landmarks-icon', 'obstacles-circle'].filter(id => m.getLayer(id) && m.getLayoutProperty(id, 'visibility') !== 'none')
  const z = m.getZoom()
  const blockers: Blocker[] = []
  if (layers.length && z >= 10) {
    const seen = new Set<string>()
    for (const f of m.queryRenderedFeatures({ layers })) {
      const g = f.geometry
      if (g.type !== 'Point') continue
      const key = `${f.layer.id}|${g.coordinates[0].toFixed(6)}|${g.coordinates[1].toFixed(6)}`
      if (seen.has(key)) continue
      seen.add(key)
      blockers.push({ lon: g.coordinates[0], lat: g.coordinates[1], r: f.layer.id === 'landmarks-icon' ? landmarkRadius(z) : obstacleRadius(z) })
    }
  }
  return blockers
}

export function viewOf(m: maplibregl.Map): View {
  const c = m.getCenter(), box = m.getCanvas()
  return { lon: c.lng, lat: c.lat, zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch(), width: box.clientWidth, height: box.clientHeight }
}

const DURING_MOVE_MS = 120      // while the map moves or zooms: place again at most this often, so a point is beside its symbol during the gesture, not only after it
const AFTER_SOURCE_MS = 80      // a landmark / obstacle source finished loading: the symbols to keep clear of changed

/** Calls `again` when the placement may have changed: right after a move or zoom ends, at most every DURING_MOVE_MS while it goes on, and shortly after one of
 *  `sources` has loaded new data (own position, traffic and trail update every second or two: those are not watched). Returns what stops it. */
export function watchView(map: maplibregl.Map, again: () => void, sources: readonly string[]): () => void {
  let t: ReturnType<typeof setTimeout> | undefined
  let last = 0
  const run = () => { clearTimeout(t); t = undefined; last = performance.now(); again() }
  const later = (ms: number) => { if (t === undefined) t = setTimeout(run, ms) }
  const during = () => { const wait = DURING_MOVE_MS - (performance.now() - last); if (wait <= 0) run(); else later(wait) }
  const end = () => { clearTimeout(t); t = undefined; requestAnimationFrame(run) }
  const onSource = (e: maplibregl.MapSourceDataEvent) => { if (e.sourceId && sources.includes(e.sourceId) && e.isSourceLoaded !== false) { clearTimeout(t); t = setTimeout(run, AFTER_SOURCE_MS) } }
  run()
  map.on('move', during)
  map.on('moveend', end)
  map.on('sourcedata', onSource)
  return () => { clearTimeout(t); map.off('move', during); map.off('moveend', end); map.off('sourcedata', onSource) }
}

/** The active countries' base waypoints as data, null while loading or after a failed load; reset the moment the countries change (another country's points must
 *  not be used for the new one). */
export function useBaseWaypoints(): { waypoints: GeoJSON.FeatureCollection | null; ref: React.MutableRefObject<GeoJSON.FeatureCollection | null> } {
  const { countries } = useActiveCountries()
  const [waypoints, setWaypoints] = useState<GeoJSON.FeatureCollection | null>(null)
  const ref = useRef<GeoJSON.FeatureCollection | null>(null)
  useEffect(() => {
    let cancelled = false
    setWaypoints(null); ref.current = null
    loadCountryGeojson('waypoints', countries).then(d => { if (!cancelled) setWaypoints(d as GeoJSON.FeatureCollection) }).catch(() => { if (!cancelled) setWaypoints(null) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countries.join(',')])
  ref.current = waypoints
  return { waypoints, ref }
}

/** When the map stops moving (zoom, pan, rotation, or the landmark and obstacle layers finished drawing): place the base VFR reporting points (RP) again.
 *  Mandatory reporting points (MRP) and holding points stay exactly where they are. */
export function useBaseWaypointDeclutter(map: maplibregl.Map | null, waypoints: GeoJSON.FeatureCollection | null): void {
  const shownWaypoints = useRef<GeoJSON.FeatureCollection | null>(null)     // what we last wrote to `ofm-waypoints` ...
  const shownBase = useRef<GeoJSON.FeatureCollection | null>(null)          // ... and the waypoints it was made from
  useEffect(() => { shownWaypoints.current = null; shownBase.current = null }, [waypoints])
  useEffect(() => {
    if (!map) return
    const again = () => {
      const src = map.getSource('ofm-waypoints') as maplibregl.GeoJSONSource | undefined
      if (!waypoints || !src) return
      const d = displaceWaypoints(waypoints, renderedSymbolBlockers(map), viewOf(map))
      const none = !d.features.some(f => (f.properties as Record<string, unknown> | null)?.['displaced'])
      // The source already holds this placement of this country's data (or the plain file, when nothing is moved and we never wrote anything).
      if (shownBase.current === waypoints ? sameDisplacement(shownWaypoints.current ?? d, d) : (none && !shownWaypoints.current)) return
      shownBase.current = waypoints
      shownWaypoints.current = d
      src.setData(d)
    }
    return watchView(map, again, ['osm-landmarks', 'openaip-obstacles', 'ofm-waypoints'])
  }, [map, waypoints])
}
