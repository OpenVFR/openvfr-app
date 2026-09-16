/**
 * SnapPicker — disambiguation picker shown when a route-planning tap lands
 * near 2+ candidate snap targets. Mirrors web's SnapPicker.tsx.
 */
import React from 'react'
import { Modal, View, Text, TouchableOpacity, Pressable } from 'react-native'
import type { RouteWaypoint } from '../utils/routeCalc'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import { CURRENT_POSITION_LABEL } from '@open-vfr/shared/snapLabels'

export type SnapCandidate = {
  kind: string
  waypoint: RouteWaypoint
}

const KIND_COLOR: Record<string, string> = {
  AD:  theme.accentBlue   ?? '#60a5fa',
  VOR: theme.accentGreen  ?? '#34d399',
  NDB: theme.accentOrange ?? '#fb923c',
  MRP: theme.accentYellow ?? '#facc15',
  RP:  theme.accentYellow ?? '#facc15',
  UWP: theme.accentYellow ?? '#facc15',
  OBS: theme.statusDanger ?? '#f87171',
  LMK: theme.textMuted    ?? '#9ca3af',
  PT:  theme.textMuted    ?? '#9ca3af',
}

interface Props {
  candidates: SnapCandidate[]
  onPick: (wp: RouteWaypoint) => void
  onClose: () => void
}

export function SnapPicker({ candidates, onPick, onClose }: Props) {
  const styles = useThemedStyles(makeStyles)
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.panel} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.header}>Add waypoint</Text>
          {candidates.map((c, i) => (
            <TouchableOpacity key={i} style={styles.item} onPress={() => { onPick(c.waypoint); onClose() }}>
              <View style={[styles.badge, { backgroundColor: KIND_COLOR[c.kind] ?? theme.textMuted }]}>
                <Text style={styles.badgeText}>{c.kind === 'PT' ? '•' : c.kind}</Text>
              </View>
              <Text style={styles.name}>{c.kind === 'PT' ? CURRENT_POSITION_LABEL : (c.waypoint.name ?? '—')}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={styles.item} onPress={onClose}>
            <View style={[styles.badge, { backgroundColor: theme.statusDanger ?? '#f87171' }]}>
              <Text style={styles.badgeText}>✕</Text>
            </View>
            <Text style={styles.name}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  panel: { backgroundColor: theme.surfacePanel ?? '#12161f', borderRadius: 10, padding: 8, minWidth: 220, maxWidth: 300 },
  header: { color: theme.textMuted ?? '#9ca3af', fontSize: 11, paddingHorizontal: 8, paddingVertical: 6 },
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 10, gap: 8 },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, minWidth: 34, alignItems: 'center' },
  badgeText: { color: '#0a0e16', fontSize: 10, fontWeight: '700' },
  name: { color: theme.textPrimary ?? '#f5f5f5', fontSize: 13, flexShrink: 1 },
} as const
}
