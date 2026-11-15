/**
 * Charts section of the aerodrome sheet (experimental): the aerodrome's official published charts from the public charts index
 * (released airfields only). A chart opens in the in-app viewer and, when it is georeferenced, on the map; every chart can also be
 * opened at the publisher. A build without the PDF module (see utils/charts.ts) opens charts at the publisher instead. Renders
 * nothing when there are no charts. Same content as web's ChartsSection.tsx.
 */
import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { CHART_KIND_LABEL, VFR_CHART_KINDS, type AerodromeCharts, type ChartEntry } from '@open-vfr/shared/chartsIndex'
import { openExternal } from '../utils/openExternal'
import { useThemedStyles, type ScaledTheme } from '../styles/theme'
import { Section } from './AerodromeBriefShared'
import {
  chartUi, pdfRenderingAvailable, useAerodromeCharts, useChartsEnabled, useChartUi, type ChartSelection,
} from '../utils/charts'

type Styles = ReturnType<typeof makeStyles>

function ChartRow({ chart, ad, styles, onShowOnMap }: { chart: ChartEntry; ad: AerodromeCharts; styles: Styles; onShowOnMap: () => void }) {
  const ui = useChartUi()
  const sel: ChartSelection = { chart, country: ad.country, icao: ad.icao, attribution: ad.source.attribution, cycle: ad.cycle }
  const onMap = ui.overlay?.chart.id === chart.id
  const canView = ad.display.document && pdfRenderingAvailable
  const canOverlay = ad.display.overlay && ad.display.document && !!chart.georef && pdfRenderingAvailable
  const open = () => { if (canView) chartUi.openViewer(sel); else openExternal(chart.url, 'the publisher’s page') }
  return (
    <View style={styles.row}>
      <Text style={styles.kind} accessibilityLabel={CHART_KIND_LABEL[chart.kind]}>{chart.kind}</Text>
      <Pressable style={styles.titleWrap} onPress={open} accessibilityRole="link" accessibilityLabel={`${canView ? 'View' : 'Open'} ${chart.title}`}>
        <Text style={styles.title} numberOfLines={2}>{chart.title}</Text>
      </Pressable>
      {canOverlay && (
        <Pressable
          style={[styles.btn, onMap && styles.btnActive]}
          onPress={() => { chartUi.toggleOverlay(sel); if (!onMap) onShowOnMap() }}
          accessibilityRole="button" accessibilityState={{ selected: onMap }}
          accessibilityLabel={onMap ? 'Remove chart from map' : 'Show chart on map'}
        >
          <Text style={[styles.btnText, onMap && styles.btnTextActive]}>{onMap ? 'On map' : 'Map'}</Text>
        </Pressable>
      )}
      {canView && (
        <Pressable style={styles.btn} onPress={() => openExternal(chart.url, 'the publisher’s page')} accessibilityRole="link" accessibilityLabel="Open the official document">
          <Text style={styles.btnText}>↗</Text>
        </Pressable>
      )}
    </View>
  )
}

export default function ChartsSection({ icao, onShowOnMap }: { icao: string | undefined; onShowOnMap?: () => void }) {
  const styles = useThemedStyles(makeStyles)
  const enabled = useChartsEnabled()
  const ad = useAerodromeCharts(icao, enabled)
  const [showAll, setShowAll] = useState(false)
  if (!enabled || !ad || ad.charts.length === 0) return null
  const vfr = ad.charts.filter(c => VFR_CHART_KINDS.has(c.kind))
  const rest = ad.charts.filter(c => !VFR_CHART_KINDS.has(c.kind))
  const shown = showAll || vfr.length === 0 ? ad.charts : vfr
  return (
    <Section title="Charts">
      {shown.map(c => <ChartRow key={c.id} chart={c} ad={ad} styles={styles} onShowOnMap={() => onShowOnMap?.()} />)}
      {rest.length > 0 && vfr.length > 0 && (
        <Pressable onPress={() => setShowAll(v => !v)} accessibilityRole="button">
          <Text style={styles.more}>{showAll ? 'Fewer charts' : `More charts (${rest.length})`}</Text>
        </Pressable>
      )}
      <Text style={styles.source}>
        <Text
          style={ad.infoUrl ? styles.link : undefined}
          onPress={ad.infoUrl ? () => openExternal(ad.infoUrl!, 'the page') : undefined}
        >{ad.source.attribution}</Text>
        {ad.cycle ? ` · effective ${ad.cycle}` : ''} · always check the official publication
      </Text>
    </Section>
  )
}

function makeStyles(theme: ScaledTheme) {
  return StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: theme.space2, minHeight: 40 },
    kind: {
      color: theme.textMuted, fontSize: theme.textXs, borderWidth: 1, borderColor: theme.borderDefault, borderRadius: theme.radiusSm,
      paddingHorizontal: 4, paddingVertical: 1, minWidth: 34, textAlign: 'center', overflow: 'hidden',
    },
    titleWrap: { flex: 1, paddingVertical: theme.space1 },
    title: { color: theme.accentBlue, fontSize: theme.textSm },
    btn: {
      minWidth: 40, minHeight: 32, paddingHorizontal: theme.space2, alignItems: 'center', justifyContent: 'center',
      borderWidth: 1, borderColor: theme.borderDefault, borderRadius: theme.radiusSm,
    },
    btnActive: { backgroundColor: theme.accentBlue, borderColor: theme.accentBlue },
    btnText: { color: theme.textPrimary, fontSize: theme.textXs },
    btnTextActive: { color: '#fff' },
    more: { color: theme.accentBlue, fontSize: theme.textSm, paddingVertical: theme.space1 },
    source: { color: theme.textMuted, fontSize: theme.textXs, marginTop: theme.space1 },
    link: { textDecorationLine: 'underline' },
  })
}
