/**
 * A georeferenced official chart drawn on the map (experimental). The chart's map frame is drawn from the publisher's PDF by the
 * native PDF module (utils/charts.ts) into a PNG and placed with an ImageSource at the four corner coordinates from the charts
 * index (`georef.crop_corners`), as a raster layer. One chart at a time. Same as web's ChartOverlay.tsx.
 *
 * Two parts: <ChartOverlayLayer/> goes INSIDE the map, below the airspace layers; <ChartOverlayBar/> is the control strip
 * (title, accuracy, opacity, remove) on the map screen.
 */
import React, { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Slider from '@react-native-community/slider'
import { ImageSource, Layer } from '@maplibre/maplibre-react-native'
import { overlayGeometry } from '@open-vfr/shared/chartsIndex'
import { overlayAccuracyLabel } from '@open-vfr/shared/chartDocument'
import { useThemedStyles, type ScaledTheme } from '../styles/theme'
import { MAP_INFO_BAR_BOTTOM_MARGIN, MAP_INFO_BAR_GAP, MAP_INFO_BAR_H } from './MapInfoBar'
import { chartUi, ChartDocumentError, ensureChartDocument, renderChartPage, useChartUi } from '../utils/charts'

/** Longer side of the drawn map frame, px (about 2.5 px per PDF point at A4), like web. */
const RENDER_PX = 3000

type Drawn = { seq: number; chartId: string; uri: string }
export type OverlayStatus = { state: 'idle' | 'loading' | 'shown' | 'error'; error?: string }

/** Status of the overlay for the bar: module-level, so the layer (inside the map) and the bar (outside it) agree. */
let status: OverlayStatus = { state: 'idle' }
const statusListeners = new Set<() => void>()
function setStatus(s: OverlayStatus) { status = s; statusListeners.forEach(l => l()) }
function useOverlayStatus(): OverlayStatus {
  const [s, setS] = useState(status)
  useEffect(() => { const l = () => setS(status); statusListeners.add(l); l(); return () => { statusListeners.delete(l) } }, [])
  return s
}

export function ChartOverlayLayer() {
  const { overlay, overlayOpacity } = useChartUi()
  const [drawn, setDrawn] = useState<Drawn | null>(null)
  const seq = useRef(0)
  const chartId = overlay?.chart.id

  useEffect(() => {
    setDrawn(null)
    const sel = overlay
    const georef = sel?.chart.georef
    if (!sel || !georef) { setStatus({ state: 'idle' }); return }
    let cancelled = false
    const abort = new AbortController()
    setStatus({ state: 'loading' })
    ;(async () => {
      try {
        const { crop } = overlayGeometry(georef)
        const doc = await ensureChartDocument(sel, abort.signal)
        const r = await renderChartPage(doc, georef.page, RENDER_PX, crop)
        if (cancelled) return
        // A new id per drawing: MapLibre Native refuses to re-add a source id it has just removed.
        setDrawn({ seq: ++seq.current, chartId: sel.chart.id, uri: r.uri })
        setStatus({ state: 'shown' })
      } catch (e) {
        if (cancelled) return
        setStatus({ state: 'error', error: e instanceof ChartDocumentError ? e.message : 'The chart could not be drawn.' })
      }
    })()
    return () => { cancelled = true; abort.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartId])

  const georef = overlay?.chart.georef
  if (!overlay || !georef || !drawn || drawn.chartId !== overlay.chart.id) return null
  const { corners } = overlayGeometry(georef)
  return (
    // key: a new drawing is a new component (ImageSource freezes its id and throws if it changes while mounted)
    <ImageSource key={drawn.seq} id={`chart-overlay-${drawn.seq}`} url={drawn.uri} coordinates={corners}>
      <Layer
        id={`chart-overlay-layer-${drawn.seq}`}
        type="raster"
        paint={{ 'raster-opacity': overlayOpacity, 'raster-fade-duration': 0, 'raster-resampling': 'linear' }}
      />
    </ImageSource>
  )
}

export function ChartOverlayBar() {
  const { overlay, overlayOpacity } = useChartUi()
  const st = useOverlayStatus()
  const styles = useThemedStyles(makeStyles)
  if (!overlay) return null
  return (
    <View style={styles.bar} accessibilityRole="toolbar" accessibilityLabel="Chart on map">
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>{overlay.icao} · {overlay.chart.title}</Text>
        <Text style={st.state === 'error' ? styles.error : styles.sub} numberOfLines={2}>
          {st.state === 'loading' && 'Loading chart…'}
          {st.state === 'error' && st.error}
          {st.state === 'shown' && `Position ${overlayAccuracyLabel(overlay.chart.georef?.accuracy_m)} · not for navigation · ${overlay.attribution}`}
        </Text>
      </View>
      <Slider
        style={styles.slider} minimumValue={0.1} maximumValue={1} step={0.05} value={overlayOpacity}
        onValueChange={chartUi.setOpacity} accessibilityLabel="Chart opacity"
      />
      <Pressable style={styles.close} onPress={chartUi.closeOverlay} accessibilityRole="button" accessibilityLabel="Remove chart from map">
        <Text style={styles.closeText}>✕</Text>
      </Pressable>
    </View>
  )
}

function makeStyles(theme: ScaledTheme) {
  return StyleSheet.create({
    bar: {
      // above the map's bottom-right info pill (scale, ceiling), not under it
      position: 'absolute', left: theme.space3, right: theme.space3, bottom: MAP_INFO_BAR_BOTTOM_MARGIN + MAP_INFO_BAR_H + MAP_INFO_BAR_GAP, flexDirection: 'row', alignItems: 'center',
      gap: theme.space2, padding: theme.space2, backgroundColor: theme.surfaceSheet, borderRadius: theme.radiusMd,
      borderWidth: 1, borderColor: theme.borderDefault,
    },
    text: { flex: 1 },
    title: { color: theme.textPrimary, fontSize: theme.textSm },
    sub: { color: theme.textMuted, fontSize: theme.textXs },
    error: { color: '#f87171', fontSize: theme.textXs },
    slider: { width: 110, height: 40 },
    close: { minWidth: 40, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
    closeText: { color: theme.textPrimary, fontSize: theme.textMd },
  })
}
