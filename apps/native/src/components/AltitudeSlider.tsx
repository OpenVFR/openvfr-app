/**
 * AltitudeSlider — native equivalent of the web AltitudeSlider component.
 *
 * Snap points match the web version exactly so settings round-trip cleanly.
 */

import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import Slider from '@react-native-community/slider'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'

const SNAP_POINTS: { ft: number; label: string }[] = [
  { ft: 500,   label: '500 ft'    },
  { ft: 1000,  label: '1 000 ft'  },
  { ft: 1500,  label: '1 500 ft'  },
  { ft: 2000,  label: '2 000 ft'  },
  { ft: 3000,  label: '3 000 ft'  },
  { ft: 4000,  label: '4 000 ft'  },
  { ft: 4500,  label: '4 500 ft'  },
  { ft: 5000,  label: '5 000 ft'  },
  { ft: 6500,  label: 'FL065'     },
  { ft: 7500,  label: '7 500 ft'  },
  { ft: 9500,  label: 'FL095'     },
  { ft: 12500, label: 'FL125'     },
  { ft: 19500, label: 'FL195'     },
  { ft: 66000, label: 'Unlimited' },
]

export const MAX_FT = SNAP_POINTS[SNAP_POINTS.length - 1].ft
const MAX_IDX = SNAP_POINTS.length - 1

function idxToFt(idx: number): number {
  return SNAP_POINTS[Math.min(Math.round(idx), MAX_IDX)].ft
}

function ftToIdx(ft: number): number {
  const idx = SNAP_POINTS.findIndex((p) => p.ft >= ft)
  return idx < 0 ? MAX_IDX : idx
}

export function ftToLabel(ft: number): string {
  return SNAP_POINTS.find((p) => p.ft === ft)?.label ?? `${ft.toLocaleString()} ft`
}

interface Props {
  ceilingFt: number
  onChange:  (ft: number) => void
}

export function AltitudeSlider({ ceilingFt, onChange }: Props) {
  const styles    = useThemedStyles(makeStyles)
  const idx       = ftToIdx(ceilingFt)
  const label     = ftToLabel(ceilingFt)
  const unlimited = ceilingFt >= 66000

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Ceiling</Text>
        <Text style={[styles.value, unlimited && styles.valueUnlimited]}>
          {label}
        </Text>
      </View>

      <Slider
        style={styles.slider}
        minimumValue={0}
        maximumValue={MAX_IDX}
        step={1}
        value={idx}
        onValueChange={(v) => onChange(idxToFt(v))}
        minimumTrackTintColor={theme.accentBlue}
        maximumTrackTintColor={theme.borderDefault}
        thumbTintColor={theme.accentBlue}
      />

      <View style={styles.legend}>
        <Text style={styles.legendText}>500 ft</Text>
        <Text style={styles.legendText}>FL095</Text>
        <Text style={styles.legendText}>Unlimited</Text>
      </View>
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
  valueUnlimited: {
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
