/**
 * A flight log's events (takeoff, landing, touch-and-go, GPS lost, airspace
 * entered), worked out when shown: the track is parsed and the airspace it
 * crosses looked up only then. Picking one opens the log on the map there.
 */
import React, { useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { flightLogEvents } from '@open-vfr/shared/flightLogEvents'
import { formatElapsed, type FlownEvent } from '@open-vfr/shared/flightLogProfile'
import { autoFlyThresholds } from '@open-vfr/shared/autoFlyDetect'
import type { AircraftProfileDocType, FlightLogDocType, TrackPoint } from '../types/db'
import { getTileUrls } from '../config'
import { loadGeoJsonOnce } from './VerticalProfile'
import { theme } from '../styles/theme'

const ICON: Record<FlownEvent['kind'], string> = {
  takeoff: '\u2197', landing: '\u2198', 'touch-and-go': '\u21c4', gap: '\u26a0', airspace: '\u25a3',
}

export function LogEventsList({ log, aircraft, onPick }: {
  log: FlightLogDocType
  aircraft?: AircraftProfileDocType
  onPick: (ts: number) => void
}) {
  const [events, setEvents] = useState<FlownEvent[] | null>(null)
  useEffect(() => {
    let cancelled = false
    const t = autoFlyThresholds(aircraft?.takeoffSpeedKts, aircraft?.category)
    loadGeoJsonOnce(getTileUrls().airspace).catch(() => null).then((airspace) => {
      if (cancelled) return
      try {
        const track = JSON.parse(log.trackJson || '[]') as TrackPoint[]
        setEvents(flightLogEvents(track, airspace, { takeoffKts: t.takeoffKts, landedKts: t.landedKts }))
      } catch { setEvents([]) }
    })
    return () => { cancelled = true }
  }, [log.trackJson, aircraft?.takeoffSpeedKts, aircraft?.category])

  if (events == null) return <Text style={styles.note}>Working out events\u2026</Text>
  if (events.length === 0) return <Text style={styles.note}>No events found.</Text>
  return (
    <View style={styles.list}>
      {events.map((e, i) => (
        <TouchableOpacity key={`${e.kind}-${e.index}-${i}`} style={styles.row} onPress={() => onPick(e.point.ts)}
          accessibilityLabel={`${e.label} at ${formatElapsed(e.point.elapsedMs)}. Open the log here.`}>
          <Text style={styles.icon}>{ICON[e.kind]}</Text>
          <Text style={styles.time}>{formatElapsed(e.point.elapsedMs)}</Text>
          <Text style={[styles.label, e.kind === 'gap' && styles.warn]} numberOfLines={1}>{e.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  list:  { marginTop: 4, gap: 2 },
  row:   { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 3 },
  icon:  { width: 14, color: theme.textSecondary, fontSize: 12 },
  time:  { minWidth: 78, color: theme.textSecondary, fontSize: 12 },
  label: { flex: 1, color: theme.textPrimary, fontSize: 12 },
  warn:  { color: theme.statusDanger },
  note:  { marginTop: 4, color: theme.textSecondary, fontSize: 12 },
})
