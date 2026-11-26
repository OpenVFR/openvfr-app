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
import { DETAIL_LAYERS, isDrawnClubPoint, landmarkLabelFilter, landmarkNamesTakenByPoints, layerFilter, replacedRunwayKeys, withoutRunways, type CircuitFocus } from '@open-vfr/shared/aerodromeDetailsStyle'
import { useAerodromeDetailsLayer, useCircuitFocus, useRelevantAerodromes } from '../utils/aerodromeDetails'
import { OVERLAY_BELOW_LAYERS } from '../styles/map-style'
import { displaceReportingPoints, sameDisplacement, waypointBlockers } from '@open-vfr/shared/symbolDeclutter'
import { renderedSymbolBlockers, useBaseWaypointDeclutter, useBaseWaypoints, viewOf, watchView } from '../utils/mapDeclutter'

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
  const { waypoints, ref: waypointsRef } = useBaseWaypoints()           // the base layer's reporting points: the true positions
  useBaseWaypointDeclutter(map, waypoints)                                // ... and the placement of its VFR points, written into the base source
  const relevantRef = useRef(relevant)
  relevantRef.current = relevant

  // Club reporting points keep clear of landmarks, obstacles and EVERY base waypoint (a mandatory reporting point is never moved: they move away from it).
  const declutter = (m: maplibregl.Map, base: GeoJSON.FeatureCollection) =>
    displaceReportingPoints(base, [...renderedSymbolBlockers(m), ...waypointBlockers(waypointsRef.current, m.getZoom())], viewOf(m), f => isDrawnClubPoint(f, relevantRef.current))
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
    const again = () => {
      const base = baseRef.current, src = map.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined
      if (!base || !src || !reportingPointsVisible) return
      const d = declutter(map, base)
      if (shown.current && sameDisplacement(shown.current, d)) return
      shown.current = d
      src.setData(d)
    }
    return watchView(map, again, ['osm-landmarks', 'openaip-obstacles'])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, reportingPointsVisible, waypoints])

  // A landmark a drawn reporting point of the same name sits on: the point's label names it, so the landmark's own label is left off
  // (one of the two always stays, and the point's finds room beside its symbol).
  useEffect(() => {
    if (!map || !map.getLayer('landmarks-label')) return
    const taken = landmarkNamesTakenByPoints(fc as { features: never[] } | null, relevant, reportingPointsVisible)
    map.setFilter('landmarks-label', landmarkLabelFilter(['!=', ['get', 'name'], ''], taken) as maplibregl.FilterSpecification)
  }, [map, fc, relevant, reportingPointsVisible])

  // A runway a person moved or resized in the review replaces the official one: the base runway lines and end numbers of the replaced one are left out
  const baseFilters = useRef<Record<string, unknown>>({})
  useEffect(() => {
    if (!map) return
    const keys = replacedRunwayKeys(fc as { features: never[] } | null)
    for (const [id, kind, list] of [['runways-outline', 'line', keys.lines], ['runways-line', 'line', keys.lines], ['runway-threshold-label', 'end', keys.ends]] as const) {
      if (!map.getLayer(id)) continue
      if (!(id in baseFilters.current)) baseFilters.current[id] = map.getFilter(id) ?? null
      map.setFilter(id, withoutRunways(baseFilters.current[id] as never, list, kind) as maplibregl.FilterSpecification | null)
    }
  }, [map, fc])

  useEffect(() => () => { if (map) { remove(map); if (map.getLayer('landmarks-label')) map.setFilter('landmarks-label', ['!=', ['get', 'name'], '']) } }, [map])

  return null
}
