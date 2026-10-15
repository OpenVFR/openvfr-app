/**
 * Georeferenced official chart drawn on the map (experimental,
 * EXPERIMENTAL_CHARTS).
 *
 * The chart's map frame is rendered client-side from the publisher's PDF
 * (pdf.js) into a canvas and placed with a MapLibre `canvas` source at the
 * four corner coordinates from the charts index (`georef.crop_corners`).
 * A canvas source needs no network fetch, so it works under the app's CSP.
 * Added/removed with the runtime API only (never a style reload), below the
 * airspace layers so aviation data stays readable on top. One chart at a time.
 */
import { useEffect, useRef, useState } from 'react'
import type * as maplibregl from 'maplibre-gl'
import { overlayGeometry } from '@open-vfr/shared/chartsIndex'
import { chartUi, loadChartDocument, renderChartPage, useChartUi, ChartDocumentError } from '../utils/charts'
import css from './ChartOverlay.module.css'

const SOURCE_ID = 'chart-overlay'
const LAYER_ID = 'chart-overlay'
/** Drawn under the first of these that exists (aviation data stays on top). */
const BELOW_LAYERS = ['airspace-fill-g', 'navaids-vor-icon', 'aerodromes-atc-ring']
/** Longer side of the rendered map frame, px. ~2.5 px per PDF point at A4. */
const RENDER_MAX_PX = 3000

function removeOverlay(map: maplibregl.Map) {
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID)
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID)
}

export default function ChartOverlay({ map }: { map: maplibregl.Map | null }) {
  const { overlay, overlayOpacity } = useChartUi()
  const [status, setStatus] = useState<'idle' | 'loading' | 'shown' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const opacityRef = useRef(overlayOpacity)
  opacityRef.current = overlayOpacity

  useEffect(() => {
    if (!map) return
    removeOverlay(map)
    setError(null)
    if (!overlay?.chart.georef) { setStatus('idle'); return }
    const { corners, crop } = overlayGeometry(overlay.chart.georef)
    let cancelled = false
    setStatus('loading')
    ;(async () => {
      try {
        const doc = await loadChartDocument(overlay.chart.url)
        const canvas = document.createElement('canvas')
        await renderChartPage(doc, overlay.chart.georef!.page, canvas, { maxPx: RENDER_MAX_PX, crop })
        if (cancelled) return
        canvasRef.current = canvas
        removeOverlay(map)
        map.addSource(SOURCE_ID, { type: 'canvas', canvas, coordinates: corners, animate: false })
        const before = BELOW_LAYERS.find(id => map.getLayer(id))
        map.addLayer({
          id: LAYER_ID, type: 'raster', source: SOURCE_ID,
          paint: { 'raster-opacity': opacityRef.current, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
        }, before)
        // Bring the chart into view only when it isn't already: a pilot
        // looking at the aerodrome keeps their zoom.
        const lngs = corners.map(c => c[0])
        const lats = corners.map(c => c[1])
        const view = map.getBounds()
        const visible = view.getWest() < Math.max(...lngs) && view.getEast() > Math.min(...lngs)
          && view.getSouth() < Math.max(...lats) && view.getNorth() > Math.min(...lats)
        if (!visible) {
          map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
            { padding: 40, duration: 800 })
        }
        setStatus('shown')
      } catch (e) {
        if (cancelled) return
        setError(e instanceof ChartDocumentError ? e.message : 'The chart could not be drawn.')
        setStatus('error')
      }
    })()
    return () => {
      cancelled = true
      removeOverlay(map)
      canvasRef.current = null
    }
  }, [map, overlay])

  useEffect(() => {
    if (map?.getLayer(LAYER_ID)) map.setPaintProperty(LAYER_ID, 'raster-opacity', overlayOpacity)
  }, [map, overlayOpacity])

  if (!overlay) return null
  const accuracy = overlay.chart.georef?.accuracy_m
  return (
    <div className={css.bar} role="group" aria-label="Chart on map">
      <div className={css.text}>
        <div className={css.title}>{overlay.icao} · {overlay.chart.title}</div>
        <div className={css.sub}>
          {status === 'loading' && 'Loading chart…'}
          {status === 'error' && <span className={css.error}>{error}</span>}
          {status === 'shown' && <>Position ±{accuracy ? Math.max(100, Math.round(accuracy / 50) * 50) : '?'} m · not for navigation · {overlay.attribution}</>}
        </div>
      </div>
      <input
        className={css.slider}
        type="range" min={10} max={100} step={5}
        value={Math.round(overlayOpacity * 100)}
        onChange={e => chartUi.setOpacity(Number(e.target.value) / 100)}
        aria-label="Chart opacity"
        title="Opacity"
      />
      <button className={css.close} onClick={chartUi.closeOverlay} aria-label="Remove chart from map">✕</button>
    </div>
  )
}
