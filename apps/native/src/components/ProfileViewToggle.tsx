/**
 * ProfileViewToggle / ProfileModeLabel: header button of the in-flight vertical profile that
 * switches between the path ahead of the aircraft and the whole planned
 * route (MapScreen, showWholeRoute). Same look as the profile header's own
 * buttons.
 */

import React from 'react'
import { Text, TouchableOpacity } from 'react-native'
import { useThemedStyles, type ScaledTheme } from '../styles/theme'

/** Short in-flight mode label for the profile header (native has no title row):
 *  "ROUTE AHEAD", "OFF ROUTE · TRK 090°", "LOOK-AHEAD · TRK 090°". */
export function ProfileModeLabel({ text, warn }: { text: string; warn?: boolean }) {
  const styles = useThemedStyles(makeStyles)
  return <Text style={[styles.mode, warn && styles.modeWarn]} numberOfLines={1}>{text}</Text>
}

export function ProfileViewToggle({ label, accessibilityLabel, onPress }: {
  label: string
  accessibilityLabel: string
  onPress: () => void
}) {
  const styles = useThemedStyles(makeStyles)
  return (
    <TouchableOpacity style={styles.btn} onPress={onPress} hitSlop={{ left: 8, right: 8 }}
      accessibilityRole="button" accessibilityLabel={accessibilityLabel}>
      <Text style={styles.txt}>{label.toUpperCase()}</Text>
    </TouchableOpacity>
  )
}

function makeStyles(theme: ScaledTheme) {
  return {
    btn: {
      borderWidth:       1,
      borderColor:       theme.borderStrong,
      borderRadius:      theme.radiusSm,
      backgroundColor:   theme.surfaceHover,
      paddingHorizontal: theme.space2,
      height:            26,
      alignItems:        'center' as const,
      justifyContent:    'center' as const,
      marginLeft:        theme.space1,
    },
    txt: { color: theme.textSecondary, fontSize: theme.textXs, fontWeight: '700' as const, letterSpacing: 0.5 },
    mode: { color: theme.textSecondary, fontSize: theme.textXs, fontWeight: '700' as const, letterSpacing: 0.5 },
    modeWarn: { color: theme.accentYellow },
  }
}
