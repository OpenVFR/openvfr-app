/**
 * LivePlogPanel — in-flight pilot log. Opened from the Map tools menu
 * (controlled `open`); a bottom sheet showing the route table with live ETA/ATA columns,
 * a progress indicator on the active leg, upcoming comm frequencies
 * (10-min lookahead), and nearby VOR/NDB nav aids.
 *
 * Ported from src/components/LivePlogPanel.tsx (web) — same data via
 * useLivePlog, table layout adapted from CSS grid to RN flex rows.
 */

import React from 'react'
import { View, Text } from 'react-native'
import { NativeSheet } from './NativeSheet'
import type { RouteWaypoint } from '../types/db'
import type { LivePlogData } from '../hooks/useLivePlog'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'

function fmtUtcTime(d: Date): string {
  return `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}z`
}

interface Props {
  waypoints:   RouteWaypoint[]
  activeWpIdx: number
  plogData:    LivePlogData
  open:        boolean
  onOpenChange: (open: boolean) => void
}

export function LivePlogPanel({ waypoints, activeWpIdx, plogData, open, onOpenChange }: Props) {
  const styles = useThemedStyles(makeStyles)
  const { atas, liveEtas, legProgressPct, upcomingFreqs, nearbyNavaids } = plogData

  if (waypoints.length < 2) return null

  return (
    <>
      <NativeSheet isPresented={open} onDismiss={() => onOpenChange(false)} title="PILOT LOG" testID="plog-sheet"
        contentContainerStyle={styles.body}>
            <View>
              {/* Route table */}
              <View style={styles.tableHead}>
                <Text style={[styles.colWp, styles.headTxt]}>Waypoint</Text>
                <Text style={[styles.colAta, styles.headTxt]}>ATA</Text>
                <Text style={[styles.colEta, styles.headTxt]}>ETA</Text>
              </View>

              {waypoints.map((wp, i) => {
                const isPast    = i > 0 && i < activeWpIdx
                const isCurrent = i === activeWpIdx
                const ata       = atas[i]
                const eta       = liveEtas[i]

                return (
                  <View key={i} style={[
                    styles.row,
                    isPast    ? styles.rowPast    : undefined,
                    isCurrent ? styles.rowCurrent : undefined,
                  ]}>
                    {isCurrent && legProgressPct != null && (
                      <View style={[styles.progressBar, { width: `${legProgressPct}%` }]} />
                    )}
                    <Text style={styles.colWp} numberOfLines={1}>
                      {wp.name ?? `WP${i + 1}`}{wp.note ? ' 📍' : ''}
                    </Text>
                    <Text style={[styles.colAta, ata ? styles.ataActual : undefined]}>
                      {ata ? fmtUtcTime(ata) : '——'}
                    </Text>
                    <Text style={[styles.colEta, isCurrent ? styles.etaCurrent : undefined]}>
                      {eta ? fmtUtcTime(eta) : '——'}
                    </Text>
                  </View>
                )
              })}

              {/* Upcoming comms */}
              {upcomingFreqs.length > 0 && (
                <View style={styles.freqSection}>
                  <Text style={styles.freqHeader}>COMMS AHEAD</Text>
                  {upcomingFreqs.map((f, i) => (
                    <View key={i} style={styles.freqRow}>
                      <Text style={styles.freqIcao}>{f.icao}</Text>
                      <Text style={styles.freqService}>{f.service}</Text>
                      <Text style={styles.freqValue}>{f.freq}</Text>
                      <Text style={styles.freqDist}>{f.distNm} NM</Text>
                    </View>
                  ))}
                </View>
              )}

              {/* Nearby navaids */}
              {nearbyNavaids.length > 0 && (
                <View style={styles.freqSection}>
                  <Text style={styles.freqHeader}>NAV AIDS</Text>
                  {nearbyNavaids.map((n, i) => (
                    <View key={i} style={styles.freqRow}>
                      <Text style={styles.freqIcao}>{n.id}</Text>
                      <Text style={styles.freqService}>{n.type}</Text>
                      <Text style={styles.freqValue}>{n.freq}</Text>
                      <Text style={styles.freqDist}>{n.distNm} NM</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
      </NativeSheet>
    </>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  body: { paddingHorizontal: theme.space4, paddingBottom: theme.space2 },
  tableHead: {
    flexDirection: 'row', paddingVertical: theme.space1,
    borderBottomWidth: 1, borderColor: theme.borderSubtle,
  },
  headTxt: { color: theme.textFaint, fontSize: theme.textXs, fontWeight: '700' },
  row: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: theme.space2,
    borderBottomWidth: 1, borderColor: theme.borderSubtle,
    position: 'relative', overflow: 'hidden',
  },
  rowPast:    { opacity: 0.5 },
  rowCurrent: { backgroundColor: 'rgba(59,130,246,0.08)' },
  progressBar: {
    position: 'absolute', left: 0, bottom: 0, height: 2,
    backgroundColor: theme.accentGreen ?? '#22c55e',
  },
  colWp:  { flex: 2, color: theme.textPrimary, fontSize: theme.textSm },
  colAta: { flex: 1, color: theme.textMuted,   fontSize: theme.textSm, textAlign: 'right' },
  colEta: { flex: 1, color: theme.textMuted,   fontSize: theme.textSm, textAlign: 'right' },
  ataActual: { color: theme.textPrimary, fontWeight: '600' },
  etaCurrent: { color: theme.accentBlue, fontWeight: '600' },
  freqSection: { marginTop: theme.space3 },
  freqHeader:  { color: theme.textFaint, fontSize: theme.textXs, fontWeight: '700', marginBottom: theme.space1, letterSpacing: 0.5 },
  freqRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: theme.space1, gap: theme.space2 },
  freqIcao:    { width: 48, color: theme.textPrimary, fontSize: theme.textSm, fontWeight: '600' },
  freqService: { width: 48, color: theme.textMuted, fontSize: theme.textXs },
  freqValue:   { flex: 1, color: theme.textPrimary, fontSize: theme.textSm },
  freqDist:    { color: theme.textFaint, fontSize: theme.textXs },
} as const
}
