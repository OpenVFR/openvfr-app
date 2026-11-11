/**
 * Aerodrome details on the map (experimental, EXPERIMENTAL_AERODROME_DETAILS):
 * noise-sensitive and other areas (fill + outline, name and heights),
 * circuit legs with direction chevrons, extra reporting points, taxiways and
 * parking, from 9 up. Dashed: outlines read off a chart (approximate),
 * schematic circuits (drawn from the stated circuit direction, not a
 * published pattern) and unreviewed values in a local preview build.
 * Added with the runtime API only, below the airspace layers.
 */
import { useEffect } from 'react'
import type * as maplibregl from 'maplibre-gl'
import { areaLabel, AREA_KINDS, DETAIL_KIND_COLOR, type DetailKind } from '@open-vfr/shared/aerodromeDetails'
import { useAerodromeDetailsLayer } from '../utils/aerodromeDetails'

const SOURCE = 'aerodrome-details'
const LAYERS = ['ad-details-fill', 'ad-details-outline', 'ad-details-outline-dashed', 'ad-details-line',
  'ad-details-line-dashed', 'ad-details-chevrons', 'ad-details-point', 'ad-details-label'] as const
const BELOW_LAYERS = ['airspace-fill-g', 'navaids-vor-icon', 'aerodromes-atc-ring']
const MIN_ZOOM = 9
const FONT = ['Noto Sans Regular']

const COLOR: maplibregl.ExpressionSpecification = ['match', ['get', 'kind'],
  ...Object.entries(DETAIL_KIND_COLOR).flatMap(([k, c]) => [k, c]), DETAIL_KIND_COLOR.other] as unknown as maplibregl.ExpressionSpecification
const DASHED: maplibregl.ExpressionSpecification = ['any', ['get', 'approximate'], ['get', 'pending'], ['==', ['get', 'schematic'], true]]
const IS_AREA: maplibregl.ExpressionSpecification = ['in', ['get', 'kind'], ['literal', [...AREA_KINDS]]]

function remove(map: maplibregl.Map) {
  for (const id of [...LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id)
  if (map.getSource(SOURCE)) map.removeSource(SOURCE)
}

export default function AerodromeDetailsLayer({ map }: { map: maplibregl.Map | null }) {
  const fc = useAerodromeDetailsLayer(!!map)

  useEffect(() => {
    if (!map || !fc) return
    // Labels are computed here (MapLibre can't format the nested limits).
    const data = {
      ...fc,
      features: fc.features.map(f => ({
        ...f,
        properties: {
          ...f.properties,
          label: (f.geometry.type === 'Point' || AREA_KINDS.has(f.properties.kind as DetailKind))
            ? [areaLabel(f.properties), f.properties.pending ? '(unreviewed)' : null].filter(Boolean).join('\n')
            : '',
        },
      })),
    }
    const src = map.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined
    if (src) { src.setData(data as GeoJSON.FeatureCollection); return }
    const before = BELOW_LAYERS.find(id => map.getLayer(id))
    map.addSource(SOURCE, { type: 'geojson', data: data as GeoJSON.FeatureCollection })
    const poly: maplibregl.FilterSpecification = ['==', ['geometry-type'], 'Polygon']
    const line: maplibregl.FilterSpecification = ['==', ['geometry-type'], 'LineString']
    map.addLayer({ id: 'ad-details-fill', type: 'fill', source: SOURCE, minzoom: MIN_ZOOM,
      filter: ['all', poly, IS_AREA],
      paint: { 'fill-color': COLOR, 'fill-opacity': ['case', ['get', 'pending'], 0.08, 0.16] } }, before)
    map.addLayer({ id: 'ad-details-outline', type: 'line', source: SOURCE, minzoom: MIN_ZOOM,
      filter: ['all', poly, ['!', DASHED]],
      paint: { 'line-color': COLOR, 'line-width': 1.8 } }, before)
    map.addLayer({ id: 'ad-details-outline-dashed', type: 'line', source: SOURCE, minzoom: MIN_ZOOM,
      filter: ['all', poly, DASHED],
      paint: { 'line-color': COLOR, 'line-width': 1.8, 'line-dasharray': [3, 2] } }, before)
    map.addLayer({ id: 'ad-details-line', type: 'line', source: SOURCE, minzoom: MIN_ZOOM,
      filter: ['all', line, ['!', DASHED]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': COLOR, 'line-width': ['case', ['==', ['get', 'kind'], 'circuit_leg'], 2.5, 1.8] } }, before)
    map.addLayer({ id: 'ad-details-line-dashed', type: 'line', source: SOURCE, minzoom: MIN_ZOOM,
      filter: ['all', line, DASHED],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': COLOR, 'line-width': 2, 'line-dasharray': [2, 2] } }, before)
    map.addLayer({ id: 'ad-details-chevrons', type: 'symbol', source: SOURCE, minzoom: 11,
      filter: ['all', line, ['==', ['get', 'kind'], 'circuit_leg']],
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 90, 'text-field': '>', 'text-font': FONT, 'text-size': 14,
        'text-keep-upright': false, 'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': COLOR, 'text-halo-color': 'rgba(0,0,0,0.6)', 'text-halo-width': 1 } }, before)
    map.addLayer({ id: 'ad-details-point', type: 'circle', source: SOURCE, minzoom: MIN_ZOOM,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 4, 'circle-color': COLOR, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1.2,
        'circle-opacity': ['case', ['get', 'pending'], 0.6, 1] } }, before)
    map.addLayer({ id: 'ad-details-label', type: 'symbol', source: SOURCE, minzoom: 10,
      filter: ['!=', ['get', 'label'], ''],
      layout: { 'text-field': ['get', 'label'], 'text-font': FONT, 'text-size': 11, 'text-max-width': 12,
        'text-offset': ['case', ['==', ['geometry-type'], 'Point'], ['literal', [0, 1.1]], ['literal', [0, 0]]],
        'text-anchor': ['case', ['==', ['geometry-type'], 'Point'], 'top', 'center'] },
      paint: { 'text-color': COLOR, 'text-halo-color': 'rgba(255,255,255,0.92)', 'text-halo-width': 1.6 } }, before)
  }, [map, fc])

  useEffect(() => () => { if (map) remove(map) }, [map])

  return null
}
