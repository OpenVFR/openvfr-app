/**
 * FeaturePopup — info popup for obstacles and navaids tapped on the map.
 */

import React from 'react'
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { theme } from '../styles/theme'

export type FeatureKind = 'navaid' | 'obstacle' | 'waypoint' | 'notam' | null

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
  notam:    '🚧',
}

export function FeaturePopup({ feature, onClose, onAddToRoute }: Props) {
  if (!feature) return null

  const icon = feature.kind ? KIND_ICON[feature.kind] : '📌'

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.icon}>{icon}</Text>
            <View>
              <Text style={styles.name}>{feature.name}</Text>
              <Text style={styles.subtitle}>{feature.subtitle}</Text>
            </View>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeTxt}>✕</Text>
          </TouchableOpacity>
        </View>

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
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: theme.surfacePanel,
    borderTopLeftRadius: theme.radiusLg, borderTopRightRadius: theme.radiusLg,
    borderTopWidth: 1, borderColor: theme.borderDefault,
  },
  header: {
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
    padding: theme.space4, borderBottomWidth: 1, borderBottomColor: theme.borderSubtle,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: theme.space2, flex: 1 },
  icon:     { fontSize: 20 },
  name:     { color: theme.textPrimary, fontSize: theme.textMd, fontWeight: '700' },
  subtitle: { color: theme.textMuted, fontSize: theme.textXs, marginTop: 2 },
  closeBtn: { padding: theme.space2 },
  closeTxt: { color: theme.textMuted, fontSize: theme.textMd },
  body:     { padding: theme.space4, gap: theme.space1 },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3,
  },
  rowLabel: { color: theme.textMuted, fontSize: theme.textSm },
  rowValue: { color: theme.textPrimary, fontSize: theme.textSm, fontWeight: '500' },
  addBtn: {
    marginTop: theme.space2, backgroundColor: theme.accentBlue,
    borderRadius: theme.radiusSm, padding: theme.space2, alignItems: 'center',
  },
  addBtnTxt: { color: '#fff', fontSize: theme.textSm, fontWeight: '600' },
})
