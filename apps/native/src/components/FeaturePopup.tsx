/**
 * FeaturePopup — info popup for obstacles and navaids tapped on the map.
 */

import React from 'react'
import { View, Text, TouchableOpacity, useWindowDimensions } from 'react-native'
import { NativeSheet } from './NativeSheet'
import { useThemedStyles, type ScaledTheme } from '../styles/theme'

// 'notam' kind removed -- all NOTAM point/circle/polygon taps now render
// through AirspacePopup's regionalNotams rows instead (see MapScreen.tsx's
// handleFeatureTap notamHits collection), matching web's fef381a commit
// which removed the equivalent parallel path in FeaturePopup.tsx there.
export type FeatureKind = 'navaid' | 'obstacle' | 'waypoint' | null

export interface FeatureInfo {
  kind:     FeatureKind
  name:     string
  subtitle: string
  rows:     { label: string; value: string }[]
  /** If set, show an "Add to route" button */
  canAddToRoute?: boolean
  lngLat?: [number, number]
}

interface Props {
  feature: FeatureInfo | null
  onClose: () => void
  onAddToRoute?: (lngLat: [number, number], name?: string) => void
}

const KIND_ICON: Record<NonNullable<FeatureKind>, string> = {
  navaid:   '📡',
  obstacle: '⚠️',
  waypoint: '📍',
}

export function FeaturePopup({ feature, onClose, onAddToRoute }: Props) {
  const styles = useThemedStyles(makeStyles)
  const { height: winH } = useWindowDimensions()
  if (!feature) return null

  const icon = feature.kind ? KIND_ICON[feature.kind] : '📌'

  return (
    <NativeSheet
      isPresented
      onDismiss={onClose}
      title={`${icon} ${feature.name}`}
      testID="feature-sheet"
      height={Math.min(150 + feature.rows.length * 30 + (feature.canAddToRoute && feature.lngLat && onAddToRoute ? 64 : 0), winH * 0.5)}
    >
      <Text style={[styles.subtitle, { paddingHorizontal: 16, paddingTop: 8 }]}>{feature.subtitle}</Text>
      <View style={styles.body}>
        {feature.rows.map((r, i) => (
          <View key={i} style={styles.row}>
            <Text style={styles.rowLabel}>{r.label}</Text>
            <Text style={styles.rowValue}>{r.value}</Text>
          </View>
        ))}

        {feature.canAddToRoute && feature.lngLat && onAddToRoute && (
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() => { onAddToRoute(feature.lngLat!, feature.name); onClose() }}
          >
            <Text style={styles.addBtnTxt}>+ Add to route</Text>
          </TouchableOpacity>
        )}
      </View>

    </NativeSheet>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  backdrop:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: theme.surfaceSheet,
    borderTopLeftRadius: theme.radiusLg, borderTopRightRadius: theme.radiusLg,
    borderTopWidth: 1, borderColor: theme.borderDefault,
  },
  header: {
    flexDirection: 'row' as const, alignItems: 'flex-start' as const, justifyContent: 'space-between' as const,
    padding: theme.space4, borderBottomWidth: 1, borderBottomColor: theme.borderSubtle,
  },
  headerLeft: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.space2, flex: 1 },
  icon:     { fontSize: theme.scale(20) },
  name:     { color: theme.textPrimary, fontSize: theme.textMd, fontWeight: '700' as const },
  subtitle: { color: theme.textMuted, fontSize: theme.textXs, marginTop: theme.scale(2) },
  closeBtn: { padding: theme.space2 },
  closeTxt: { color: theme.textMuted, fontSize: theme.textMd },
  body:     { padding: theme.space4, gap: theme.space1 },
  row: {
    flexDirection: 'row' as const, justifyContent: 'space-between' as const, paddingVertical: theme.scale(3),
  },
  rowLabel: { color: theme.textMuted, fontSize: theme.textSm },
  rowValue: { color: theme.textPrimary, fontSize: theme.textSm, fontWeight: '500' as const },
  addBtn: {
    marginTop: theme.space2, backgroundColor: theme.accentBlue,
    borderRadius: theme.radiusSm, padding: theme.space2, alignItems: 'center' as const,
  },
  addBtnTxt: { color: '#fff', fontSize: theme.textSm, fontWeight: '600' as const },
 }
}
