/**
 * GpsInstruments — compact instrument strip rendered over the map.
 * Shows: ground speed · altitude · track · GPS status indicator.
 * Tapping altitude toggles ft AMSL / GPS accuracy display.
 *
 * @deprecated Replaced by GaugesBar.tsx (GS/T.ALT/TT/UTC/WIND bar) in
 * MapScreen. Kept here unused in case the old design is preferred after
 * testing — not currently rendered anywhere.
 */

import React, { useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import type { GpsPosition } from '../utils/gpsTypes'
import type { GpsStatus }   from '../hooks/useGps'
import { distanceNm }       from '../utils/routeCalc'
import type { RouteWaypoint } from '../utils/routeCalc'
import { theme } from '../styles/theme'

type Props = {
  position:    GpsPosition | null
  status:      GpsStatus
  flying:      boolean
  onToggleFly: () => void
  /** Next route waypoint to show distance/ETA for */
  nextWaypoint?: RouteWaypoint | null
}

export function GpsInstruments({ position, status, flying, onToggleFly, nextWaypoint }: Props) {
  const [showAccuracy, setShowAccuracy] = useState(false)

  // Distance and ETA to next waypoint
  const nextDist = position && nextWaypoint
    ? distanceNm({ lat: position.lat, lng: position.lng }, nextWaypoint)
    : null
  const nextEta = nextDist && position && position.speedKts > 5
    ? Math.round((nextDist / position.speedKts) * 60)  // minutes
    : null

  const statusColor: Record<GpsStatus, string> = {
    idle:        theme.textFaint,
    requesting:  theme.accentYellow,
    active:      theme.statusOk,
    denied:      theme.statusDanger,
    unavailable: theme.statusDanger,
  }

  const spd  = position ? Math.round(position.speedKts) : '--'
  const alt  = position ? (showAccuracy ? `±${Math.round(position.accuracy)}m` : `${Math.round(position.altFt)}'`) : '--'
  const trk  = position ? `${Math.round(position.trackDeg).toString().padStart(3, '0')}°` : '---'

  return (
    <View style={styles.strip}>
      {/* GPS status dot */}
      <View style={[styles.dot, { backgroundColor: statusColor[status] }]} />

      {/* Speed */}
      <View style={styles.cell}>
        <Text style={styles.value}>{spd}</Text>
        <Text style={styles.unit}>kts</Text>
      </View>

      <View style={styles.divider} />

      {/* Altitude — tap to toggle accuracy */}
      <TouchableOpacity style={styles.cell} onPress={() => setShowAccuracy(v => !v)}>
        <Text style={styles.value}>{alt}</Text>
        <Text style={styles.unit}>{showAccuracy ? 'acc' : 'ft'}</Text>
      </TouchableOpacity>

      <View style={styles.divider} />

      {/* Track */}
      <View style={styles.cell}>
        <Text style={styles.value}>{trk}</Text>
        <Text style={styles.unit}>TRK</Text>
      </View>

      {/* Next waypoint distance + ETA */}
      {nextDist != null && (
        <>
          <View style={styles.divider} />
          <View style={styles.cell}>
            <Text style={styles.value}>{nextDist.toFixed(1)}</Text>
            <Text style={styles.unit}>NM</Text>
          </View>
          {nextEta != null && (
            <View style={styles.cell}>
              <Text style={[styles.value, { color: theme.accentBlue }]}>{nextEta}</Text>
              <Text style={styles.unit}>min</Text>
            </View>
          )}
        </>
      )}

      {/* Go Flying button */}
      <TouchableOpacity
        style={[styles.flyBtn, flying && styles.flyBtnActive]}
        onPress={onToggleFly}
      >
        <Text style={[styles.flyBtnText, flying && styles.flyBtnTextActive]}>
          {flying ? '■ STOP' : '▶ FLY'}
        </Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  strip: {
    position:        'absolute',
    bottom:          0,
    left:            0,
    right:           0,
    height:          52,
    backgroundColor: 'rgba(10,14,22,0.92)',
    borderTopWidth:  1,
    borderTopColor:  theme.borderDefault,
    flexDirection:   'row',
    alignItems:      'center',
    paddingHorizontal: theme.space3,
    gap:             theme.space2,
  },
  dot: {
    width:        8,
    height:       8,
    borderRadius: 4,
    marginRight:  theme.space1,
  },
  cell: {
    flexDirection: 'row',
    alignItems:    'baseline',
    gap:           3,
  },
  value: {
    color:      theme.textPrimary,
    fontSize:   theme.textLg,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  unit: {
    color:    theme.textMuted,
    fontSize: theme.textXs,
  },
  divider: {
    width:           1,
    height:          24,
    backgroundColor: theme.borderSubtle,
    marginHorizontal: theme.space1,
  },
  flyBtn: {
    marginLeft:      'auto',
    paddingHorizontal: theme.space3,
    paddingVertical: theme.space2,
    borderRadius:    theme.radiusMd,
    borderWidth:     1,
    borderColor:     theme.accentGreen,
  },
  flyBtnActive: {
    backgroundColor: theme.accentRed,
    borderColor:     theme.accentRed,
  },
  flyBtnText: {
    color:      theme.accentGreen,
    fontSize:   theme.textSm,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  flyBtnTextActive: {
    color: '#fff',
  },
})
