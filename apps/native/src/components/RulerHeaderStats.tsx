/**
 * RulerHeaderStats — Map Ruler readout rendered inside VerticalProfile's own
 * drag-handle row (via its headerStart/headerEnd slots), native counterpart
 * to web's RulerSummaryStrip.tsx. Lives in the profile panel's chrome rather
 * than as a separate floating overlay so it reads as part of the same panel
 * the pilot is already looking at.
 *
 *   headerStart: DIST · MAG · TRUE
 *   headerEnd:   ETE · fuel (when an aircraft profile is set) · clear
 */

import React from 'react'
import { Text, TouchableOpacity, type TextStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { bearingDeg, distanceNm, magneticBearingDeg } from '@open-vfr/shared/routeCalc'
import type { RouteWaypoint, AircraftProfileDocType } from '../types/db'
import { type Units, nmToDisplay, distLabel } from '../utils/units'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'

function fmtBrg(deg: number): string {
  return `${Math.round(deg).toString().padStart(3, '0')}°`
}

function fmtTime(hours: number): string {
  const totalMin = Math.round(hours * 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h === 0 ? `${m}min` : `${h}h${m.toString().padStart(2, '0')}`
}

function Item({ label, value }: { label: string; value: string }) {
  const styles = useThemedStyles(makeStyles)
  return (
    <Text style={styles.item} numberOfLines={1}>
      <Text style={styles.label}>{label} </Text>
      <Text style={styles.value}>{value}</Text>
    </Text>
  )
}

export function RulerHeaderStart({ from, to, units }: { from: RouteWaypoint; to: RouteWaypoint; units: Units }) {
  const distDisplay = nmToDisplay(distanceNm(from, to), units.distance)
  return (
    <>
      <Item label="DIST" value={`${distDisplay.toFixed(1)} ${distLabel(units.distance)}`} />
      <Item label="MAG" value={fmtBrg(magneticBearingDeg(from, to))} />
      <Item label="TRUE" value={fmtBrg(bearingDeg(from, to))} />
    </>
  )
}

export function RulerHeaderEnd({ from, to, aircraftProfile, onClear }: {
  from: RouteWaypoint
  to: RouteWaypoint
  aircraftProfile?: AircraftProfileDocType
  onClear: () => void
}) {
  const styles    = useThemedStyles(makeStyles)
  const cruiseKts = aircraftProfile?.cruiseIas ?? null
  const eteHours  = cruiseKts && cruiseKts > 0 ? distanceNm(from, to) / cruiseKts : null
  const fuelL     = eteHours != null && aircraftProfile ? eteHours * aircraftProfile.fuelBurnLhr : null
  return (
    <>
      {eteHours != null && <Item label="ETE" value={fmtTime(eteHours)} />}
      {fuelL != null && <Item label="FUEL" value={`${Math.round(fuelL)}L`} />}
      <TouchableOpacity style={styles.clearBtn} onPress={onClear} hitSlop={8} accessibilityLabel="Clear ruler">
        <Ionicons name="close" size={12} color={theme.textSecondary} />
      </TouchableOpacity>
    </>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  item: {
    flexShrink: 1,
  },
  label: {
    color:         theme.textFaint,
    fontSize:      9,
    fontWeight:    '700',
    letterSpacing: 0.5,
  },
  value: {
    color:       theme.textPrimary,
    fontSize:    11,
    fontWeight:  '600',
    fontVariant: ['tabular-nums'] as TextStyle['fontVariant'],
  },
  clearBtn: {
    borderWidth:       1,
    borderColor:       theme.borderStrong,
    borderRadius:      theme.radiusSm,
    backgroundColor:   theme.surfaceHover,
    paddingHorizontal: 4,
    paddingVertical:   1,
  },
} as const
}
