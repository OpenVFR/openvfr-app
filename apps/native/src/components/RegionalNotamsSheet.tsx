/**
 * RegionalNotamsSheet — native equivalent of web's RegionalNotamsPanel +
 * SideDrawer "Regional NOTAMs" section, combined into one bottom sheet
 * (mirroring MapDisplaySheet.tsx's Modal pattern, native's standard for
 * this kind of toggleable panel).
 *
 * Lists FIR-wide NOTAMs (restricted/danger areas, navaid outages, AIRAC
 * amendments, military notices) that aren't tied to any single airport --
 * including ones with no useful map geometry to render as a circle/pin at
 * all (a "MAP" badge marks entries that do have one). Route-proximity
 * filtered when a route is planned (see @open-vfr/shared/notamRouteFilter),
 * same "narrow route brief" concept as web -- SkyDemon's manual describes
 * the same idea (NOTAMs within a configurable buffer of the planned route,
 * not the whole area's active count).
 */

import React, { useMemo } from 'react'
import { View, Text, TouchableOpacity, Modal, ScrollView, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { theme } from '../styles/theme'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import { fmtNotamDate } from '@open-vfr/shared/fetchNotam'
import { filterNotamsNearRoute, DEFAULT_ROUTE_NOTAM_BUFFER_NM } from '@open-vfr/shared/notamRouteFilter'
import type { RouteWaypoint } from '@open-vfr/shared/types'

interface Props {
  notams:    NotamItem[]
  waypoints: RouteWaypoint[]
}

export function RegionalNotamsSheet({ notams, waypoints }: Props) {
  const [open, setOpen] = React.useState(false)
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set())

  const hasRoute = waypoints.length > 0
  const displayed = useMemo(
    () => (hasRoute ? filterNotamsNearRoute(notams, waypoints, DEFAULT_ROUTE_NOTAM_BUFFER_NM) : notams),
    [notams, waypoints, hasRoute],
  )

  const toggle = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  return (
    <>
      <TouchableOpacity style={styles.trigger} onPress={() => setOpen(true)}>
        <Ionicons name="warning-outline" size={20} color={theme.textSecondary} />
        {displayed.length > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeTxt}>{displayed.length}</Text>
          </View>
        )}
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setOpen(false)} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Regional NOTAMs</Text>
            <TouchableOpacity onPress={() => setOpen(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={18} color={theme.textMuted} />
            </TouchableOpacity>
          </View>

          {hasRoute && (
            <Text style={styles.filterNote}>
              Filtered to within {DEFAULT_ROUTE_NOTAM_BUFFER_NM}nm of planned route
            </Text>
          )}

          <ScrollView showsVerticalScrollIndicator={false} style={styles.scroll}>
            {displayed.length === 0 && (
              <Text style={styles.empty}>
                No active regional NOTAMs{hasRoute ? ` within ${DEFAULT_ROUTE_NOTAM_BUFFER_NM}nm of route` : ''}
              </Text>
            )}
            {displayed.map((n) => {
              const expanded = expandedIds.has(n.id)
              const hasGeo = n.lat !== null && n.lon !== null
              const eff = fmtNotamDate(n.effective)
              const exp = fmtNotamDate(n.expires)
              return (
                <View key={n.id} style={styles.item}>
                  <TouchableOpacity style={styles.itemHeader} onPress={() => toggle(n.id)}>
                    <Text style={styles.itemId}>{n.id}</Text>
                    {hasGeo && (
                      <View style={styles.mapBadge}>
                        <Text style={styles.mapBadgeTxt}>MAP</Text>
                      </View>
                    )}
                    <Text style={styles.itemPeriod} numberOfLines={1}>
                      {eff}{exp ? ` \u2013 ${exp}` : ''}
                    </Text>
                    <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={theme.textFaint} />
                  </TouchableOpacity>
                  {expanded && <Text style={styles.itemText}>{n.text}</Text>}
                </View>
              )
            })}
            <View style={{ height: 16 }} />
          </ScrollView>
        </View>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  trigger: {
    width: 40, height: 40, borderRadius: theme.radiusMd,
    backgroundColor: 'rgba(19,24,36,0.90)', borderWidth: 1, borderColor: theme.borderDefault,
    alignItems: 'center', justifyContent: 'center',
  },
  badge: {
    position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8,
    backgroundColor: '#e64980', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3,
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
  filterNote: {
    color: theme.textFaint, fontSize: 10, fontStyle: 'italic',
    paddingHorizontal: theme.space4, paddingTop: theme.space2,
  },
  scroll: { paddingHorizontal: theme.space4 },
  empty: { color: theme.textFaint, fontSize: 11, paddingVertical: theme.space3 },
  item: { borderTopWidth: 1, borderTopColor: theme.borderSubtle, paddingVertical: 6 },
  itemHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  itemId: { fontSize: 11, fontWeight: '700', color: theme.textPrimary },
  itemPeriod: { fontSize: 10, color: theme.textFaint, flex: 1 },
  mapBadge: {
    borderWidth: 1, borderColor: 'rgba(230,73,128,0.4)', backgroundColor: 'rgba(230,73,128,0.1)',
    borderRadius: 3, paddingHorizontal: 4, paddingVertical: 1,
  },
  mapBadgeTxt: { fontSize: 9, fontWeight: '700', color: '#e64980' },
  itemText: {
    fontSize: 11, color: theme.textSecondary, marginTop: 4, lineHeight: 16,
    backgroundColor: theme.surfaceOverlay, borderRadius: 6, padding: 8,
  },
})
