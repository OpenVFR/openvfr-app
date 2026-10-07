/**
 * AutoFlyBanner — pill shown when takeoff or landing is detected and the
 * "Auto flying mode" setting is 'Ask'. Accept starts/stops flight mode.
 */

import React from 'react'
import { View, Text, TouchableOpacity } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'

export function AutoFlyBanner({ kind, top, onAccept, onDismiss }: {
  kind: 'start' | 'stop'
  top: number
  onAccept: () => void
  onDismiss: () => void
}) {
  const styles = useThemedStyles(makeStyles)
  return (
    <View style={[styles.bar, { top }]} testID="auto-fly-banner" accessibilityRole="alert">
      <Ionicons name={kind === 'start' ? 'airplane-outline' : 'airplane'} size={18} color={theme.textPrimary} />
      <Text style={styles.text} numberOfLines={1}>
        {kind === 'start' ? 'Airborne? Start flying mode' : 'Landed? Stop flying mode'}
      </Text>
      <TouchableOpacity style={styles.acceptBtn} onPress={onAccept} hitSlop={6} testID="auto-fly-accept">
        <Text style={styles.acceptText}>{kind === 'start' ? 'Start' : 'Stop'}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onDismiss} hitSlop={8} accessibilityLabel="Dismiss" testID="auto-fly-dismiss">
        <Ionicons name="close" size={18} color={theme.textFaint} />
      </TouchableOpacity>
    </View>
  )
}

function makeStyles(theme: ScaledTheme) {
  return {
    bar: {
      position: 'absolute' as const, alignSelf: 'center' as const,
      zIndex: 47,
      flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.space3,
      backgroundColor: 'rgba(19,24,36,0.94)', borderRadius: theme.radiusFull,
      borderWidth: 1, borderColor: '#a855f7',
      paddingLeft: theme.space3, paddingRight: theme.space3, paddingVertical: theme.space1,
    },
    text: { color: theme.textPrimary, fontSize: 13, flexShrink: 1 },
    acceptBtn: {
      paddingHorizontal: theme.space3, paddingVertical: 4, borderRadius: theme.radiusFull,
      backgroundColor: '#a855f7',
    },
    acceptText: { color: '#fff', fontWeight: '600' as const, fontSize: 13 },
  }
}
