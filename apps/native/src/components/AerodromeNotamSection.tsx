/**
 * AerodromeNotamSection — the NOTAMs-tab content extracted verbatim from
 * AerodromePopup.tsx, so it can be reused wherever a single aerodrome's
 * NOTAM list needs the exact same display without a full aerodrome tap
 * (e.g. VicinityBriefSheet.tsx's NOTAM tab).
 *
 * Optionally also renders the FIR-wide "Other NOTAMs" list below the
 * aerodrome's own NOTAMs -- restricted/danger areas, navaid outages,
 * military notices not tied to any single airport, filtered + sorted to
 * the planned route via @open-vfr/shared/notamRouteFilter's
 * filterAndSortNotamsNearRoute. This was previously duplicated inline in
 * VicinityBriefSheet.tsx (the only consumer that happened to have
 * regionalNotams/waypoints in scope) and entirely missing from
 * AerodromePopup.tsx's own NOTAM tab (the map-tap popup never showed
 * regional NOTAMs at all) -- one shared component now covers both, so a
 * tapped aerodrome's NOTAM tab and the Vicinity Brief's NOTAM tab show the
 * exact same "other NOTAMs near me" list. `regionalNotams`/`routeWaypoints`
 * undefined (the default) = section omitted entirely, same as before this
 * capability existed.
 *
 * Fully self-contained: owns its own expand/collapse state per NOTAM id
 * (own-aerodrome and FIR-wide lists share the same expand-state Set, keyed
 * by nmsId -- globally unique, so no collision risk between the two lists).
 */

import React, { useState } from 'react'
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import { fmtNotamDate, type NotamItem } from '@open-vfr/shared/fetchNotam'
import { filterAndSortNotamsNearRoute, DEFAULT_ROUTE_NOTAM_BUFFER_NM, type RoutePoint } from '@open-vfr/shared/notamRouteFilter'
import { Section } from './AerodromeBriefShared'

interface Props {
  notams:       NotamItem[]
  notamLoading: boolean
  /** FIR-wide NOTAMs (unfiltered) + the route to filter/sort them against --
   *  see this file's own doc comment. Omit both to skip the section. */
  regionalNotams?:  NotamItem[]
  routeWaypoints?:  RoutePoint[]
}

// Single-line truncated preview, mirrors web's RegionalNotamsPanel.tsx --
// NMS-API's `text` is already plain English prose, so a plain character-
// count truncation is meaningfully informative, not just codes.
const PREVIEW_LEN = 80
function previewText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_LEN ? `${flat.slice(0, PREVIEW_LEN)}\u2026` : flat
}

export default function AerodromeNotamSection({ notams, notamLoading, regionalNotams, routeWaypoints }: Props) {
  const styles = useThemedStyles(makeStyles)
  const [expandedNotams, setExpandedNotams] = useState<Set<string>>(new Set())

  function toggleNotam(id: string) {
    setExpandedNotams((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const hasRoute = !!routeWaypoints && routeWaypoints.length > 0
  const otherNotams = regionalNotams === undefined
    ? null
    : hasRoute
      ? filterAndSortNotamsNearRoute(regionalNotams, routeWaypoints!, DEFAULT_ROUTE_NOTAM_BUFFER_NM)
      : regionalNotams

  return (
    <>
      <Section title={`NOTAMs${notams.length > 0 ? ` (${notams.length})` : ''}`}>
        {notamLoading && <ActivityIndicator size="small" color={theme.accentBlue} />}
        {!notamLoading && notams.length === 0 && (
          <Text style={styles.muted}>No NOTAMs</Text>
        )}
        {notams.map((n) => {
          // nmsId, not display id, for expand-state/React key -- see
          // apps/api/src/notam.ts's NotamItem.nmsId comment.
          const expanded = expandedNotams.has(n.nmsId)
          return (
            <TouchableOpacity key={n.nmsId} style={styles.notamRow} onPress={() => toggleNotam(n.nmsId)}>
              <Text style={styles.notamId}>{n.id} {expanded ? '▴' : '▾'}</Text>
              {n.effective && (
                <Text style={styles.notamDate}>{fmtNotamDate(n.effective)} → {fmtNotamDate(n.expires)}</Text>
              )}
              {!expanded && <Text style={styles.notamPreview} numberOfLines={1}>{previewText(n.text)}</Text>}
              {expanded && <Text style={styles.notamText}>{n.text}</Text>}
            </TouchableOpacity>
          )
        })}
      </Section>

      {/* Non-aerodrome FIR-wide NOTAMs -- military notices, navaid outages,
          AIRAC amendments -- no single airport to pick. Omitted entirely
          when regionalNotams isn't wired up (see Props' own doc comment). */}
      {otherNotams !== null && (
        <View style={styles.otherNotams}>
          <Text style={styles.otherNotamsTitle}>
            OTHER NOTAMS{otherNotams.length > 0 ? ` (${otherNotams.length})` : ''}
          </Text>
          {hasRoute && (
            <Text style={styles.filterNote}>
              Filtered to within {DEFAULT_ROUTE_NOTAM_BUFFER_NM}nm of planned route
            </Text>
          )}
          {otherNotams.length === 0 && (
            <Text style={styles.muted}>No other active regional NOTAMs</Text>
          )}
          {otherNotams.map((n) => {
            // nmsId, not display id, for expand-state/React key -- see
            // apps/api/src/notam.ts's NotamItem.nmsId comment.
            const expanded = expandedNotams.has(n.nmsId)
            const hasGeo = n.lat !== null && n.lon !== null
            const isMilitary = n.classification === 'MILITARY'
            return (
              <TouchableOpacity key={n.nmsId} style={styles.otherNotamRow} onPress={() => toggleNotam(n.nmsId)}>
                <View style={styles.otherNotamHeader}>
                  {n.icaoLocation && (
                    <View style={styles.locBadge}>
                      <Text style={styles.locBadgeTxt}>{n.icaoLocation}</Text>
                    </View>
                  )}
                  {isMilitary && (
                    <View style={styles.milBadge}>
                      <Text style={styles.milBadgeTxt}>MIL</Text>
                    </View>
                  )}
                  <Text style={styles.otherNotamId}>{n.id}</Text>
                  {hasGeo && (
                    <View style={styles.mapBadge}>
                      <Text style={styles.mapBadgeTxt}>MAP</Text>
                    </View>
                  )}
                  <Text style={styles.otherNotamPeriod} numberOfLines={1}>
                    {fmtNotamDate(n.effective)}{n.expires ? ` – ${fmtNotamDate(n.expires)}` : ''}
                  </Text>
                  <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={theme.textFaint} />
                </View>
                {!expanded && (
                  <Text style={styles.otherNotamPreview} numberOfLines={1}>{previewText(n.text)}</Text>
                )}
                {expanded && <Text style={styles.otherNotamText}>{n.text}</Text>}
              </TouchableOpacity>
            )
          })}
        </View>
      )}
    </>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  muted: {
    color:    theme.textSecondary,
    fontSize: theme.textSm,
    fontStyle: 'italic',
  },
  notamRow: {
    gap:          3,
    paddingVertical: theme.space2,
    borderBottomWidth: 1,
    borderBottomColor: theme.borderSubtle,
  },
  notamId: {
    color:      theme.accentBlue,
    fontSize:   theme.textMd,
    fontWeight: '700',
  },
  notamDate: {
    color:    theme.textSecondary,
    fontSize: theme.textXs,
  },
  notamText: {
    color:    theme.textSecondary,
    fontSize: theme.textSm,
    lineHeight: 17,
    marginTop: 2,
  },
  notamPreview: {
    color:    theme.textFaint,
    fontSize: theme.textXs,
    marginTop: 1,
  },
  otherNotams: { marginTop: theme.space3, gap: 2 },
  otherNotamsTitle: { color: theme.textSecondary, fontSize: theme.textSm, fontWeight: '700', letterSpacing: 0.8, marginBottom: theme.space2 },
  filterNote: { color: theme.textFaint, fontSize: 10, fontStyle: 'italic', marginBottom: theme.space2 },
  otherNotamRow: { paddingVertical: theme.space2, borderTopWidth: 1, borderTopColor: theme.borderSubtle },
  otherNotamHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  otherNotamId: { fontSize: theme.textSm, fontWeight: '700', color: theme.textPrimary },
  otherNotamPeriod: { fontSize: 10, color: theme.textFaint, flex: 1 },
  mapBadge: {
    borderWidth: 1, borderColor: 'rgba(230,73,128,0.4)', backgroundColor: 'rgba(230,73,128,0.1)',
    borderRadius: 3, paddingHorizontal: 4, paddingVertical: 1,
  },
  mapBadgeTxt: { fontSize: 9, fontWeight: '700', color: '#e64980' },
  locBadge: {
    borderWidth: 1, borderColor: theme.borderSubtle, backgroundColor: theme.surfaceHover,
    borderRadius: 3, paddingHorizontal: 4, paddingVertical: 1,
  },
  locBadgeTxt: { fontSize: 9, fontWeight: '700', color: theme.textSecondary },
  milBadge: {
    borderWidth: 1, borderColor: 'rgba(240,140,0,0.4)', backgroundColor: 'rgba(240,140,0,0.12)',
    borderRadius: 3, paddingHorizontal: 4, paddingVertical: 1,
  },
  milBadgeTxt: { fontSize: 9, fontWeight: '700', color: '#f08c00' },
  otherNotamPreview: { fontSize: 10, color: theme.textFaint, marginTop: 2 },
  otherNotamText: {
    fontSize: theme.textSm, color: theme.textSecondary, marginTop: 4, lineHeight: 16,
    backgroundColor: theme.surfaceOverlay ?? theme.surfaceHover, borderRadius: 6, padding: 8,
  },
 } as const
}
