/**
 * SnapPicker — disambiguation picker shown when a route-planning tap lands
 * near 2+ candidate snap targets. Mirrors web's SnapPicker.tsx.
 */
import React from 'react'
import { View, Text, TouchableOpacity, Image } from 'react-native'
import { NativeSheet } from './NativeSheet'
import type { RouteWaypoint } from '../utils/routeCalc'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import { CURRENT_POSITION_LABEL } from '@open-vfr/shared/snapLabels'

export type SnapCandidate = {
  kind: string
  waypoint: RouteWaypoint
  /** Verbose picker-only label -- falls back to waypoint.name when absent.
   *  See AviationMap.tsx's extractSnapName/extractSnapDisplayName split. */
  displayName?: string
  /** Map icon name (assets/poi_icons) shown instead of the text badge (obstacles and landmarks). */
  icon?: string | null
}

const ICONS: Record<string, number> = {
  'obs-wind-turbine': require('../../assets/poi_icons/obs-wind-turbine.png'),
  'obs-tower':        require('../../assets/poi_icons/obs-tower.png'),
  'obs-chimney':      require('../../assets/poi_icons/obs-chimney.png'),
  'obs-building':     require('../../assets/poi_icons/obs-building.png'),
  'obs-other':        require('../../assets/poi_icons/obs-other.png'),
  'lmk-church':       require('../../assets/poi_icons/lmk-church.png'),
  'lmk-mast':         require('../../assets/poi_icons/lmk-mast.png'),
  'lmk-windmill':     require('../../assets/poi_icons/lmk-windmill.png'),
  'lmk-water-tower':  require('../../assets/poi_icons/lmk-water-tower.png'),
  'lmk-chimney':      require('../../assets/poi_icons/lmk-chimney.png'),
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
    <NativeSheet
      isPresented
      onDismiss={onClose}
      title="Add route point"
      testID="snap-picker-sheet"
    >
      {candidates.map((c, i) => (
        <TouchableOpacity key={i} style={styles.item} onPress={() => { onPick(c.waypoint); onClose() }}>
          {c.icon && ICONS[c.icon] ? (
            <View style={styles.iconBox}><Image source={ICONS[c.icon]} style={styles.icon} resizeMode="contain" /></View>
          ) : (
            <View style={[styles.badge, { backgroundColor: KIND_COLOR[c.kind] ?? theme.textMuted }]}>
              <Text style={styles.badgeText}>{c.kind === 'PT' ? '•' : c.kind}</Text>
            </View>
          )}
          <Text style={styles.name}>{c.kind === 'PT' ? CURRENT_POSITION_LABEL : (c.displayName ?? c.waypoint.name ?? '—')}</Text>
        </TouchableOpacity>
      ))}
      <TouchableOpacity style={styles.item} onPress={onClose}>
        <View style={[styles.badge, { backgroundColor: theme.statusDanger ?? '#f87171' }]}>
          <Text style={styles.badgeText}>✕</Text>
        </View>
        <Text style={styles.name}>Cancel</Text>
      </TouchableOpacity>
    </NativeSheet>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  panel: { backgroundColor: theme.surfaceSheet, borderRadius: 10, padding: 8, minWidth: 220, maxWidth: 300 },
  header: { color: theme.textMuted ?? '#9ca3af', fontSize: 11, paddingHorizontal: 8, paddingVertical: 6 },
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 10, gap: 8 },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, minWidth: 34, alignItems: 'center' },
  iconBox: { minWidth: 34, alignItems: 'center' },
  icon: { width: 26, height: 26 },
  badgeText: { color: '#0a0e16', fontSize: 10, fontWeight: '700' },
  name: { color: theme.textPrimary ?? '#f5f5f5', fontSize: 13, flexShrink: 1 },
} as const
}
