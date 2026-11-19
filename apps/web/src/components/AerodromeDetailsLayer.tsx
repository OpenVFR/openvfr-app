/**
 * Aerodrome details on the map (experimental): areas, extra reporting points,
 * taxiways and parking; circuits in zoom steps (drawn legs, turn arrows for circuits known only by direction, runway
 * labels); orbit direction at holding points. The layers, filters and data are shared with native
 * (@open-vfr/shared/aerodromeDetailsStyle); this component only feeds them to maplibre-gl. Circuits follow the
 * "Traffic circuits" switch and the runway end tapped in the aerodrome popup; orbits follow "Holding points".
 * Added with the runtime API only, below the airspace layers.
 */
import { useEffect } from 'react'
import type * as maplibregl from 'maplibre-gl'
import { DETAIL_LAYERS, layerFilter, type CircuitFocus } from '@open-vfr/shared/aerodromeDetailsStyle'
import { useAerodromeDetailsLayer, useCircuitFocus, useRelevantAerodromes } from '../utils/aerodromeDetails'
import { OVERLAY_BELOW_LAYERS } from '../styles/map-style'

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

  useEffect(() => {
    if (!map || !fc) return
    const src = map.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined
    if (src) { src.setData(fc as GeoJSON.FeatureCollection); return }
    const before = OVERLAY_BELOW_LAYERS.find(id => map.getLayer(id))
    map.addSource(SOURCE, { type: 'geojson', data: fc as GeoJSON.FeatureCollection })
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

  useEffect(() => () => { if (map) remove(map) }, [map])

  return null
}
