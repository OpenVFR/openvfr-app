/**
 * WeatherAlongRouteSheet — native equivalent of web's WeatherAlongRoutePanel,
 * bottom-sheet wrapped the same way as RegionalNotamsSheet.tsx.
 */

import React from 'react'
import { View, Text, TouchableOpacity, Modal, ScrollView } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import type { RouteWeatherStation } from '../hooks/useWeatherAlongRoute'

interface Props {
  stations: RouteWeatherStation[]
}

const FR_COLOR: Record<string, string> = {
  VFR:  '#4ade80',
  MVFR: '#93c5fd',
  IFR:  '#f87171',
  LIFR: '#c084fc',
}

export function WeatherAlongRouteSheet({ stations }: Props) {
  const styles = useThemedStyles(makeStyles)
  const [open, setOpen] = React.useState(false)
  if (stations.length === 0) return null

  return (
    <>
      <TouchableOpacity style={styles.trigger} onPress={() => setOpen(true)}>
        <Ionicons name="partly-sunny-outline" size={20} color={theme.textSecondary} />
        <View style={styles.badge}>
          <Text style={styles.badgeTxt}>{stations.length}</Text>
        </View>
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setOpen(false)} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Weather Along Route</Text>
            <TouchableOpacity onPress={() => setOpen(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={18} color={theme.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} style={styles.scroll}>
            {stations.map((s) => (
              <View key={s.icao} style={styles.item}>
                <View style={styles.itemHeader}>
                  <Text style={styles.icao}>{s.icao}</Text>
                  <Text style={styles.dist}>{s.distNm} nm</Text>
                  {s.decoded?.flightRule && (
                    <View style={[styles.frBadge, { borderColor: FR_COLOR[s.decoded.flightRule] }]}>
                      <Text style={[styles.frBadgeTxt, { color: FR_COLOR[s.decoded.flightRule] }]}>
                        {s.decoded.flightRule}
                      </Text>
                    </View>
                  )}
                </View>
                <Text style={styles.raw}>{s.metar ?? 'No METAR available'}</Text>
              </View>
            ))}
            <View style={{ height: 16 }} />
          </ScrollView>
        </View>
      </Modal>
    </>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  trigger: {
    width: 40, height: 40, borderRadius: theme.radiusMd,
    backgroundColor: 'rgba(19,24,36,0.90)', borderWidth: 1, borderColor: theme.borderDefault,
    alignItems: 'center', justifyContent: 'center',
  },
  badge: {
    position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8,
    backgroundColor: '#3b82f6', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3,
  },
  badgeTxt: { color: '#ffffff', fontSize: 9, fontWeight: '700' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: theme.surfacePanel, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 1, borderColor: theme.borderDefault, maxHeight: '75%', paddingBottom: 8,
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderDefault, alignSelf: 'center', marginTop: 10, marginBottom: 4 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: theme.space4, paddingVertical: theme.space2,
    borderBottomWidth: 1, borderBottomColor: theme.borderSubtle,
  },
  headerTitle: { color: theme.textPrimary, fontSize: theme.textMd, fontWeight: '700' },
  scroll: { paddingHorizontal: theme.space4, paddingTop: theme.space2 },
  item: { borderTopWidth: 1, borderTopColor: theme.borderSubtle, paddingVertical: 6 },
  itemHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  icao: { fontSize: 12, fontWeight: '700', color: theme.textPrimary },
  dist: { fontSize: 10, color: theme.textFaint, flex: 1 },
  frBadge: { borderWidth: 1, borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1 },
  frBadgeTxt: { fontSize: 9, fontWeight: '700' },
  raw: { fontSize: 10, color: theme.textSecondary, marginTop: 4, lineHeight: 15 },
} as const
}
