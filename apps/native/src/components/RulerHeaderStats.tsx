/**
 * RulerHeaderStats — Map Ruler readout rendered inside VerticalProfile's own
 * drag-handle row (via its headerStart/headerEnd slots), native counterpart
 * to web's RulerSummaryStrip.tsx. Lives in the profile panel's chrome rather
 * than as a separate floating overlay so it reads as part of the same panel
 * the pilot is already looking at.
 *
 *   headerStart: DIST · magnetic (°M) · true (°T) bearing
 *   headerEnd:   ETE · fuel (when an aircraft profile is set) · clear
 */

import React from 'react'
import { Text, TouchableOpacity, type TextStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { bearingDeg, distanceNm, magneticBearingDeg } from '@open-vfr/shared/routeCalc'
import type { RouteWaypoint, LegOverride, AircraftProfileDocType } from '../types/db'
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

/** Bearing as value + reference suffix ("305°M", "311°T"). Far
 *  narrower than a "MAG"/"TRUE" label in front: headerStart only gets half
 *  the drag-handle row minus the grip (~180 dp on a phone), and DIST plus
 *  two labelled bearings overflowed it, so Android ellipsized every item. */
function BearingItem({ deg, reference }: { deg: number; reference: 'M' | 'T' }) {
  const styles = useThemedStyles(makeStyles)
  return (
    <Text style={styles.item} numberOfLines={1}>
      <Text style={styles.value}>{fmtBrg(deg)}</Text>
      <Text style={styles.label}>{reference}</Text>
    </Text>
  )
}

export function RulerHeaderStart({ from, to, units }: { from: RouteWaypoint; to: RouteWaypoint; units: Units }) {
  const distDisplay = nmToDisplay(distanceNm(from, to), units.distance)
  return (
    <>
      <Item label="DIST" value={`${distDisplay.toFixed(1)} ${distLabel(units.distance)}`} />
      <BearingItem deg={magneticBearingDeg(from, to)} reference="M" />
      <BearingItem deg={bearingDeg(from, to)} reference="T" />
    </>
  )
}

/** Loaded/edited route: total DIST and ETE (per-leg speed overrides, else the
 *  aircraft's cruise speed; ETE is omitted without either). No wind applied. */
export function RouteHeaderStart({ waypoints, legOverrides, units, cruiseKts }: {
  waypoints: RouteWaypoint[]
  legOverrides: LegOverride[]
  units: Units
  cruiseKts?: number
}) {
  let nm = 0
  let hours = 0
  let haveSpeed = true
  for (let i = 0; i < waypoints.length - 1; i++) {
    const d = distanceNm(waypoints[i], waypoints[i + 1])
    nm += d
    const tas = legOverrides[i]?.speedKts ?? cruiseKts
    if (tas && tas > 0) hours += d / tas
    else haveSpeed = false
  }
  return (
    <>
      <Item label="DIST" value={`${nmToDisplay(nm, units.distance).toFixed(1)} ${distLabel(units.distance)}`} />
      {haveSpeed && waypoints.length >= 2 && <Item label="ETE" value={fmtTime(hours)} />}
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
      <TouchableOpacity style={styles.clearBtn} onPress={onClear} hitSlop={{ left: 8, right: 8 }} accessibilityLabel="Clear ruler">
        <Ionicons name="close" size={16} color={theme.textSecondary} />
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
    // Fills the 30 dp header row; hitSlop only widens it sideways since the
    // row's own bounds cap touch height on Android.
    minWidth:          36,
    height:            26,
    alignItems:        'center',
    justifyContent:    'center',
  },
} as const
}
