/**
 * TrafficFilterSlider — slider for the traffic vertical filter (hide traffic
 * more than N ft above/below own altitude). Same steps as the web version;
 * the last step (0) means "All".
 */

import React from 'react'
import { View, Text } from 'react-native'
import Slider from '@react-native-community/slider'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import { TRAFFIC_VERT_FILTER_OPTIONS, type TrafficVertFilter } from '../hooks/useSettings'

const STEPS = TRAFFIC_VERT_FILTER_OPTIONS
const MAX_IDX = STEPS.length - 1

export function trafficFilterLabel(v: TrafficVertFilter): string {
  return v === 0 ? 'All' : `\u00b1${v.toLocaleString('en').replace(',', ' ')} ft`
}

interface Props {
  value:    TrafficVertFilter
  onChange: (v: TrafficVertFilter) => void
  /** Flying mode: the filter is active. Otherwise all traffic is shown. */
  flying:   boolean
}

export function TrafficFilterSlider({ value, onChange, flying }: Props) {
  const styles = useThemedStyles(makeStyles)
  const found = STEPS.indexOf(value)
  const idx = found >= 0 ? found : STEPS.indexOf(5000)

  return (
    <View style={styles.container} testID="traffic-vert-slider">
      <View style={styles.header}>
        <Text style={styles.title}>Traffic vertical filter</Text>
        <Text style={[styles.value, value === 0 && styles.valueAll]}>{trafficFilterLabel(value)}</Text>
      </View>
      <Slider
        style={styles.slider}
        minimumValue={0}
        maximumValue={MAX_IDX}
        step={1}
        value={idx}
        onValueChange={(v) => onChange(STEPS[Math.min(Math.round(v), MAX_IDX)])}
        minimumTrackTintColor={theme.accentBlue}
        maximumTrackTintColor={theme.borderDefault}
        thumbTintColor={theme.accentBlue}
        accessibilityLabel={`Traffic vertical filter: ${trafficFilterLabel(value)}`}
      />
      <View style={styles.legend}>
        <Text style={styles.legendText}>{'\u00b11 000 ft'}</Text>
        <Text style={styles.legendText}>All</Text>
      </View>
      <Text style={styles.legendText}>
        {flying ? 'Hides traffic further than this above or below you.' : 'Not flying: all traffic is shown. The filter starts in flying mode.'}
      </Text>
    </View>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  container: {
    paddingHorizontal: theme.space3,
    paddingVertical:   theme.space3,
    gap:               theme.space1,
  },
  header: {
    flexDirection:  'row' as const,
    justifyContent: 'space-between' as const,
    alignItems:     'center' as const,
    marginBottom:   theme.space1,
  },
  title: {
    color:      theme.textSecondary,
    fontSize:   theme.textSm,
    fontWeight: '500' as const,
  },
  value: {
    color:      theme.accentBlue,
    fontSize:   theme.textSm,
    fontWeight: '700' as const,
  },
  valueAll: {
    color: theme.textMuted,
  },
  slider: {
    width:  '100%' as const,
    height: theme.scale(36),
  },
  legend: {
    flexDirection:  'row' as const,
    justifyContent: 'space-between' as const,
    marginTop:      theme.space1,
  },
  legendText: {
    color:    theme.textFaint,
    fontSize: theme.textXs,
  },
 }
}
