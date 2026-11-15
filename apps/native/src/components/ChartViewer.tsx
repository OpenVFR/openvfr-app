/**
 * In-app viewer for an official chart document (experimental): the PDF is fetched from the publisher into the cache
 * (utils/charts.ts), one page at a time is drawn by the native PDF module, zoomable in steps and scrollable. Mount once on the
 * map screen; it shows while a chart is selected with chartUi.openViewer. Same look as web's ChartViewer.tsx (close, page, zoom).
 */
import React, { useEffect, useState } from 'react'
import { ActivityIndicator, Image, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useThemedStyles, type ScaledTheme } from '../styles/theme'
import {
  chartUi, ChartDocumentError, ensureChartDocument, pdfRenderingAvailable, renderChartPage, useChartUi, type RenderedImage,
} from '../utils/charts'

const ZOOMS = [1, 2, 3] as const

export default function ChartViewer() {
  const { viewer } = useChartUi()
  const styles = useThemedStyles(makeStyles)
  const insets = useSafeAreaInsets()
  const { width: winW } = useWindowDimensions()
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState<number>(1)
  const [docUri, setDocUri] = useState<string | null>(null)
  const [img, setImg] = useState<RenderedImage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const chartId = viewer?.chart.id

  useEffect(() => {                                           // a new chart starts at page 1, fitted
    setPage(1); setZoom(1); setDocUri(null); setImg(null); setError(null)
    if (!viewer || !pdfRenderingAvailable) return
    const abort = new AbortController()
    setBusy(true)
    ensureChartDocument(viewer, abort.signal)
      .then(setDocUri)
      .catch(e => { if (!abort.signal.aborted) { setError(e instanceof ChartDocumentError ? e.message : 'The chart could not be loaded.'); setBusy(false) } })
    return () => abort.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartId])

  useEffect(() => {
    if (!docUri) return
    let cancelled = false
    setBusy(true)
    renderChartPage(docUri, page, winW * zoom * 2)           // ~2x the screen width in px per zoom step, capped by the pixel limit
      .then(r => { if (!cancelled) { setImg(r); setError(null); setBusy(false) } })
      .catch(() => { if (!cancelled) { setError('The chart could not be drawn.'); setBusy(false) } })
    return () => { cancelled = true }
  }, [docUri, page, zoom, winW])

  if (!viewer) return null
  const pages = img?.pageCount ?? 1
  const shownW = winW * zoom
  const shownH = img ? shownW * (img.height / img.width) : 0
  return (
    <Modal visible animationType="slide" onRequestClose={chartUi.closeViewer} statusBarTranslucent>
      <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.bar}>
          <View style={styles.titleCol}>
            <Text style={styles.title} numberOfLines={1}>{viewer.icao} · {viewer.chart.title}</Text>
            <Text style={styles.sub} numberOfLines={1}>{viewer.attribution}{viewer.cycle ? ` · effective ${viewer.cycle}` : ''} · not for navigation</Text>
          </View>
          <Pressable style={styles.btn} onPress={() => { void Linking.openURL(viewer.chart.url) }} accessibilityRole="link" accessibilityLabel="Open at the publisher">
            <Text style={styles.btnText}>↗</Text>
          </Pressable>
          <Pressable style={styles.btn} onPress={chartUi.closeViewer} accessibilityRole="button" accessibilityLabel="Close chart">
            <Text style={styles.btnText}>✕</Text>
          </Pressable>
        </View>
        <View style={styles.tools}>
          {ZOOMS.map(z => (
            <Pressable key={z} style={[styles.btn, zoom === z && styles.btnActive]} onPress={() => setZoom(z)} accessibilityRole="button" accessibilityLabel={`Zoom ${z}x`}>
              <Text style={[styles.btnText, zoom === z && styles.btnTextActive]}>{z}×</Text>
            </Pressable>
          ))}
          {pages > 1 && (
            <>
              <Pressable style={styles.btn} disabled={page <= 1} onPress={() => setPage(p => Math.max(1, p - 1))} accessibilityLabel="Previous page"><Text style={[styles.btnText, page <= 1 && styles.dim]}>‹</Text></Pressable>
              <Text style={styles.sub}>{page} / {pages}</Text>
              <Pressable style={styles.btn} disabled={page >= pages} onPress={() => setPage(p => Math.min(pages, p + 1))} accessibilityLabel="Next page"><Text style={[styles.btnText, page >= pages && styles.dim]}>›</Text></Pressable>
            </>
          )}
          {busy && <ActivityIndicator style={styles.spin} />}
        </View>
        {error && <Text style={styles.error}>{error}</Text>}
        <ScrollView style={styles.fill} contentContainerStyle={styles.pad} maximumZoomScale={1} bounces={false}>
          <ScrollView horizontal bounces={false} nestedScrollEnabled>
            {img && <Image source={{ uri: img.uri }} style={{ width: shownW, height: shownH, backgroundColor: '#fff' }} resizeMode="contain" accessibilityLabel={`${viewer.chart.title}, page ${page}`} />}
          </ScrollView>
        </ScrollView>
      </View>
    </Modal>
  )
}

function makeStyles(theme: ScaledTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.surfaceSheet },
    bar: { flexDirection: 'row', alignItems: 'center', gap: theme.space2, padding: theme.space3, borderBottomWidth: 1, borderBottomColor: theme.borderSubtle },
    titleCol: { flex: 1 },
    title: { color: theme.textPrimary, fontSize: theme.textMd },
    sub: { color: theme.textMuted, fontSize: theme.textXs },
    tools: { flexDirection: 'row', alignItems: 'center', gap: theme.space2, paddingHorizontal: theme.space3, paddingVertical: theme.space2 },
    btn: {
      minWidth: 44, minHeight: 40, alignItems: 'center', justifyContent: 'center', paddingHorizontal: theme.space2,
      borderWidth: 1, borderColor: theme.borderDefault, borderRadius: theme.radiusSm,
    },
    btnActive: { backgroundColor: theme.accentBlue, borderColor: theme.accentBlue },
    btnText: { color: theme.textPrimary, fontSize: theme.textMd },
    btnTextActive: { color: '#fff' },
    dim: { opacity: 0.35 },
    spin: { marginLeft: theme.space2 },
    error: { color: '#f87171', padding: theme.space3, fontSize: theme.textSm },
    fill: { flex: 1 },
    pad: { flexGrow: 1 },
  })
}
