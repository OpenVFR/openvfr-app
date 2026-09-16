/**
 * RulerStatsBadge — compact native counterpart to web's RulerPanel.tsx.
 * Deliberately condensed (a floating single-row badge, not a full section
 * with coordinate readouts) since native's screen real estate doesn't have
 * an equivalent SideDrawer to host a larger panel in — the VerticalProfile
 * cross-section rendered alongside this is the primary payoff of the Map
 * Ruler tool; this badge just adds the numeric distance/track/ETE/fuel web
 * shows next to it.
 */

import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { bearingDeg, distanceNm, magneticBearingDeg } from '@open-vfr/shared/routeCalc'
import type { RouteWaypoint } from '../types/db'
import type { AircraftProfileDocType } from '../types/db'
import { type Units, nmToDisplay, distLabel } from '../utils/units'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'

interface Props {
  from: RouteWaypoint
  to: RouteWaypoint
  units: Units
  aircraftProfile?: AircraftProfileDocType
  /** Distance in px from the screen bottom to sit just above the
   *  VerticalProfile chart (which the caller already knows the height of). */
  bottom: number
}

function fmtBrg(deg: number): string {
  return `${Math.round(deg).toString().padStart(3, '0')}°`
}

function fmtTime(hours: number): string {
  const totalMin = Math.round(hours * 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h === 0 ? `${m}min` : `${h}h${m}m`
}

export function RulerStatsBadge({ from, to, units, aircraftProfile, bottom }: Props) {
  const styles = useThemedStyles(makeStyles)
  const distNmVal   = distanceNm(from, to)
  const distDisplay = nmToDisplay(distNmVal, units.distance)
  const trueBrg     = bearingDeg(from, to)
  const magBrg      = magneticBearingDeg(from, to)
  const cruiseKts   = aircraftProfile?.cruiseIas ?? null
  const eteHours    = cruiseKts && cruiseKts > 0 ? distNmVal / cruiseKts : null
  const fuelL       = eteHours != null && aircraftProfile ? eteHours * aircraftProfile.fuelBurnLhr : null

  return (
    <View style={[styles.badge, { bottom }]} pointerEvents="none">
      <Text style={styles.txt}>
        {distDisplay.toFixed(1)} {distLabel(units.distance)} · {fmtBrg(trueBrg)}T / {fmtBrg(magBrg)}M
        {eteHours != null ? ` · ETE ${fmtTime(eteHours)}` : ''}
        {fuelL != null ? ` · ${Math.round(fuelL)}L` : ''}
      </Text>
    </View>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  badge: {
    position:          'absolute',
    left:               theme.space3,
    right:              theme.space3,
    backgroundColor:    'rgba(15,23,42,0.85)',
    borderRadius:       theme.radiusSm,
    borderWidth:        1,
    borderColor:        'rgba(250,204,21,0.4)',
    paddingHorizontal:  theme.space2,
    paddingVertical:    4,
  },
  txt: {
    color:      '#facc15',
    fontSize:   11,
    fontWeight: '600',
    textAlign:  'center',
  },
} as const
}
