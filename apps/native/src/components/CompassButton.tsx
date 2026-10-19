/**
 * CompassButton — map orientation control, replacing MapLibre's built-in
 * compass (which only appeared once the map was rotated, could not be styled
 * or placed with the other controls, and sat under the toolbar).
 *
 * - Needle shows where north is (rotates against the map bearing).
 * - Shown while the map is rotated, or while flying (then it also shows the
 *   orientation mode: blue border = Track Up). On the ground with the map
 *   facing north it is hidden, like a standard compass.
 * - Tap while flying cycles North Up -> Track Up -> Course Up (when a route
 *   leg exists) -> North Up. A small T / C badge names the mode.
 * - Tap, North Up but rotated by hand: re-align to north.
 * - Tap on the ground, rotated: re-align to north.
 * It is the only orientation control (no toolbar tile).
 *
 * The bearing comes in through a ValueStore so a rotating gesture re-renders
 * only this button, not the whole map screen.
 */

import React from 'react'
import { Text, TouchableOpacity, View, type StyleProp, type ViewStyle } from 'react-native'
import type { MapOrientation } from '../utils/gpsTypes'
import Svg, { Path } from 'react-native-svg'
import { useStoreValue, type ValueStore } from '../utils/valueStore'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'

/** Smallest bearing (degrees) that counts as "rotated". */
const ROTATED_DEG = 1

export function CompassButton({
  bearingStore, orientation, canToggle, onResetNorth, onNextOrientation, style,
}: {
  bearingStore: ValueStore<number>
  /** Current orientation mode. */
  orientation: MapOrientation
  /** Orientation can be toggled (flying). */
  canToggle: boolean
  /** Go to North Up and re-align the map to north. */
  onResetNorth: () => void
  /** Advance to the next orientation mode (North -> Track -> Course -> North). */
  onNextOrientation: () => void
  style?: StyleProp<ViewStyle>
}) {
  const styles = useThemedStyles(makeStyles)
  const bearing = useStoreValue(bearingStore)
  const norm = ((bearing % 360) + 540) % 360 - 180   // -180..180, 0 = north up
  const rotated = Math.abs(norm) > ROTATED_DEG
  if (!rotated && !canToggle) return null
  const trackUp = orientation !== 'north'
  // Flying: tap cycles the mode, except for a north-up map the pilot turned by
  // hand, which just re-aligns.
  const cycles = canToggle && (trackUp || !rotated)
  const label = !cycles ? 'Map is rotated. Tap for north up'
    : orientation === 'north' ? 'North up. Tap for track up'
    : orientation === 'track' ? 'Track up. Tap for next orientation'
    : 'Course up. Tap for north up'
  return (
    <TouchableOpacity
      style={[styles.btn, trackUp && styles.btnActive, style]}
      activeOpacity={0.85}
      onPress={cycles ? onNextOrientation : onResetNorth}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID="map-compass"
    >
      <View style={{ transform: [{ rotate: `${-bearing}deg` }] }}>
        <Svg width={22} height={22} viewBox="0 0 24 24">
          {/* north half in red, south half neutral */}
          <Path d="M12 2 L17.5 13 H6.5 Z" fill="#ef4444" />
          <Path d="M12 22 L6.5 13 H17.5 Z" fill={theme.textPrimary} opacity={0.85} />
        </Svg>
      </View>
      {trackUp && <Text style={styles.badge}>{orientation === 'course' ? 'C' : 'T'}</Text>}
    </TouchableOpacity>
  )
}

function makeStyles(t: ScaledTheme) {
  return {
    btn: {
      width:           40,
      height:          40,
      borderRadius:    20,
      backgroundColor: t.surfaceSheet,
      borderWidth:     1,
      borderColor:     t.borderDefault,
      alignItems:      'center' as const,
      justifyContent:  'center' as const,
    },
    btnActive: { borderColor: t.accentBlue },
    badge: { position: 'absolute' as const, right: 4, bottom: 2, fontSize: 9, fontWeight: '800' as const, color: t.accentBlue },
  }
}
