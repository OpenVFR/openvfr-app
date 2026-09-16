/**
 * CloudProfile — native port of web's CloudProfile.tsx (vertical cloud-layer
 * altitude chart). RN's `top`/`bottom` layout props accept percentage
 * strings the same way CSS does, so the absolute-positioned-gridline/layer
 * approach ports directly -- only the element types (View/Text/Svg instead
 * of div/svg) differ.
 */

import { View, Text, StyleSheet } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { theme } from '../styles/theme'
import type { ParsedCloudLayer } from '@open-vfr/shared/fetchWx'

interface Props {
  clouds: ParsedCloudLayer[]
}

const COVER_LABEL: Record<ParsedCloudLayer['cover'], string> = {
  FEW: 'Few', SCT: 'Scattered', BKN: 'Broken', OVC: 'Overcast',
}

const COVER_COLOR: Record<ParsedCloudLayer['cover'], string> = {
  FEW: theme.textSecondary,
  SCT: theme.textSecondary,
  BKN: theme.textPrimary,
  OVC: theme.textPrimary,
}

const CLOUD_ICON_PATH = 'M6 18 a3.5 3.5 0 0 1 0.3 -6.98 A4.5 4.5 0 0 1 15 10.2 A3.2 3.2 0 0 1 18 18 Z'
const PLOT_HEIGHT = 110

export default function CloudProfile({ clouds }: Props) {
  if (clouds.length === 0) return null

  const maxFt = Math.max(...clouds.map((l) => l.baseFt))
  const topFt = Math.max(3000, Math.ceil((maxFt * 1.15) / 1000) * 1000)
  const gridlines: number[] = []
  for (let ft = 0; ft <= topFt; ft += 1000) gridlines.push(ft)

  const sorted = [...clouds].sort((a, b) => a.baseFt - b.baseFt)

  return (
    <View style={styles.chart}>
      <View style={styles.plot}>
        {gridlines.map((ft) => (
          <View key={ft} style={[styles.gridline, { bottom: `${(ft / topFt) * 100}%` as unknown as number }]}>
            <Text style={styles.gridLabel}>{ft === 0 ? 'GND' : `${(ft / 1000).toFixed(0)}k`}</Text>
          </View>
        ))}
        {sorted.map((layer, i) => (
          <View key={i} style={[styles.layer, { bottom: `${(layer.baseFt / topFt) * 100}%` as unknown as number }]}>
            <Svg viewBox="0 0 24 24" width={20} height={20}>
              <Path d={CLOUD_ICON_PATH} fill={COVER_COLOR[layer.cover]} opacity={layer.cover === 'FEW' ? 0.75 : layer.cover === 'SCT' ? 0.9 : 1} />
            </Svg>
            <Text style={styles.layerLabel}>{COVER_LABEL[layer.cover]} {layer.baseFt.toLocaleString()} ft</Text>
          </View>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  chart: {
    marginBottom: theme.space2,
  },
  plot: {
    position: 'relative',
    height: PLOT_HEIGHT,
    marginLeft: 36,
    borderLeftWidth: 1.5,
    borderLeftColor: theme.textMuted,
  },
  gridline: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderTopWidth: 1,
    borderTopColor: theme.borderSubtle,
    borderStyle: 'dashed',
  },
  gridLabel: {
    position: 'absolute',
    left: -34,
    top: -7,
    width: 30,
    textAlign: 'right',
    fontSize: 11,
    fontWeight: '600',
    color: theme.textSecondary,
  },
  layer: {
    position: 'absolute',
    left: 6,
    right: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    transform: [{ translateY: 8 }],
  },
  layerLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.textPrimary,
    backgroundColor: theme.surfaceBase,
    paddingHorizontal: 3,
  },
})
