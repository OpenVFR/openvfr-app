/**
 * Aerodrome details on the map (experimental): areas, extra reporting points,
 * taxiways and parking; circuits in zoom steps (drawn legs, turn arrows for circuits known only by direction, runway
 * labels); orbit direction at holding points. The layers, filters and data are shared with native
 * (@open-vfr/shared/aerodromeDetailsStyle); this component only feeds them to maplibre-gl. Circuits follow the
 * "Traffic circuits" switch and the runway end tapped in the aerodrome popup; orbits follow "Holding points".
 * Added with the runtime API only, below the airspace layers.
 */
import { useEffect, useRef } from 'react'
import type * as maplibregl from 'maplibre-gl'
import { DETAIL_LAYERS, landmarkLabelFilter, landmarkNamesTakenByPoints, layerFilter, type CircuitFocus } from '@open-vfr/shared/aerodromeDetailsStyle'
import { useAerodromeDetailsLayer, useCircuitFocus, useRelevantAerodromes } from '../utils/aerodromeDetails'
import { OVERLAY_BELOW_LAYERS } from '../styles/map-style'
import { displaceReportingPoints, landmarkRadius, obstacleRadius, sameDisplacement, type Blocker, type View } from '@open-vfr/shared/symbolDeclutter'

const SOURCE = 'aerodrome-details'

function remove(map: maplibregl.Map) {
  for (const l of [...DETAIL_LAYERS].reverse()) if (map.getLayer(l.id)) map.removeLayer(l.id)
  if (map.getSource(SOURCE)) map.removeSource(SOURCE)
}

function apply(map: maplibregl.Map, visible: { circuits: boolean; holdings: boolean; reportingPoints: boolean }, focus: CircuitFocus | null, relevant: readonly string[]) {
  for (const l of DETAIL_LAYERS) {
    if (!map.getLayer(l.id) || l.group === 'details') continue
    map.setLayoutProperty(l.id, 'visibility', visible[l.group] ? 'visible' : 'none')
    if (l.group === 'circuits' || l.group === 'reportingPoints') map.setFilter(l.id, layerFilter(l, focus, relevant) as maplibregl.FilterSpecification)
  }
}

export default function AerodromeDetailsLayer({ map, circuitsVisible, holdingsVisible, reportingPointsVisible }:
  { map: maplibregl.Map | null; circuitsVisible: boolean; holdingsVisible: boolean; reportingPointsVisible: boolean }) {
  const fc = useAerodromeDetailsLayer(!!map)
  const focus = useCircuitFocus()
  const relevant = useRelevantAerodromes()

  const shown = useRef<GeoJSON.FeatureCollection | null>(null)     // what the source holds now (reporting points possibly moved clear of other symbols)
  // The reporting points are moved clear of the landmark and obstacle symbols the map draws (not the labels: those find room by themselves):
  // computed for the current view, again when the map stops moving.
  const declutter = (m: maplibregl.Map, base: GeoJSON.FeatureCollection) => {
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
    const c = m.getCenter(), box = m.getCanvas()
    const view: View = { lon: c.lng, lat: c.lat, zoom: z, bearing: m.getBearing(), pitch: m.getPitch(), width: box.clientWidth, height: box.clientHeight }
    return displaceReportingPoints(base as never, blockers, view) as unknown as GeoJSON.FeatureCollection
  }
  const baseRef = useRef<GeoJSON.FeatureCollection | null>(null)
  baseRef.current = fc as GeoJSON.FeatureCollection | null

  useEffect(() => {
    if (!map || !fc) return
    const src = map.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined
    if (src) { const d = declutter(map, fc as GeoJSON.FeatureCollection); shown.current = d; src.setData(d); return }
    const before = OVERLAY_BELOW_LAYERS.find(id => map.getLayer(id))
    shown.current = declutter(map, fc as GeoJSON.FeatureCollection)
    map.addSource(SOURCE, { type: 'geojson', data: shown.current })
    // Reporting points sit above the landmark icons (a church is often the very spot a point is named after): below the
    // traffic layers, else on top.
    const aboveLandmarks = ['traffic-urgency-ring', 'traffic-symbols', 'wind-arrows-icon'].find(id => map.getLayer(id))
    for (const l of DETAIL_LAYERS) {
      map.addLayer({ id: l.id, type: l.type, source: SOURCE, minzoom: l.minzoom, filter: l.filter,
        ...(l.layout ? { layout: l.layout } : {}), paint: l.paint } as maplibregl.AddLayerObject,
      l.group === 'reportingPoints' ? aboveLandmarks : before)
    }
  }, [map, fc])

  // Layers-panel switches and runway focus; also right after the layers are first added.
  useEffect(() => {
    if (map && fc) apply(map, { circuits: circuitsVisible, holdings: holdingsVisible, reportingPoints: reportingPointsVisible }, focus, relevant)
  }, [map, fc, circuitsVisible, holdingsVisible, reportingPointsVisible, focus, relevant])

  // When the map stops moving (zoom, pan, rotation, or the landmark and obstacle layers finished drawing): place the points again.
  useEffect(() => {
    if (!map) return
    let t: ReturnType<typeof setTimeout> | undefined
    const again = () => {
      const base = baseRef.current, src = map.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined
      if (!base || !src || !reportingPointsVisible) return
      const d = declutter(map, base)
      if (shown.current && sameDisplacement(shown.current as never, d as never)) return
      shown.current = d
      src.setData(d)
    }
    const soon = () => { clearTimeout(t); t = setTimeout(again, 250) }
    map.on('moveend', soon)
    map.on('sourcedata', soon)
    return () => { clearTimeout(t); map.off('moveend', soon); map.off('sourcedata', soon) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, reportingPointsVisible])

  // A landmark a drawn reporting point of the same name sits on: the point's label names it, so the landmark's own label is left off
  // (one of the two always stays, and the point's finds room beside its symbol).
  useEffect(() => {
    if (!map || !map.getLayer('landmarks-label')) return
    const taken = landmarkNamesTakenByPoints(fc as { features: never[] } | null, relevant, reportingPointsVisible)
    map.setFilter('landmarks-label', landmarkLabelFilter(['!=', ['get', 'name'], ''], taken) as maplibregl.FilterSpecification)
  }, [map, fc, relevant, reportingPointsVisible])

  useEffect(() => () => { if (map) { remove(map); if (map.getLayer('landmarks-label')) map.setFilter('landmarks-label', ['!=', ['get', 'name'], '']) } }, [map])

  return null
}
