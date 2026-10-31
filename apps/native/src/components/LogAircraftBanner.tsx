/**
 * LogAircraftBanner — after a flight log closes without an aircraft (none was
 * selected when it started), asks which aircraft flew it. One tap on an
 * aircraft sets it on the log and selects it for the next flights; the cross
 * leaves the log as it is (the aircraft can still be set from the log list).
 *
 * Shown only on the ground: a log closes after landing (park timer), never in
 * flight, so this never asks for attention while flying.
 */

import React from 'react'
import { View, Text, TouchableOpacity, ScrollView } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'

export function LogAircraftBanner({ route, choices, top, onPick, onDismiss }: {
  /** e.g. "ESMI → ESMI" */
  route: string
  choices: { id: string; label: string }[]
  top: number
  onPick: (aircraftId: string) => void
  onDismiss: () => void
}) {
  const styles = useThemedStyles(makeStyles)
  return (
    <View style={[styles.bar, { top }]} testID="log-aircraft-banner" accessibilityRole="alert">
      <View style={styles.head}>
        <Ionicons name="airplane-outline" size={16} color={theme.textPrimary} />
        <Text style={styles.text} numberOfLines={2}>
          Flight {route} logged without an aircraft. Which one did you fly?
        </Text>
        <TouchableOpacity onPress={onDismiss} hitSlop={8} accessibilityLabel="Dismiss" testID="log-aircraft-dismiss">
          <Ionicons name="close" size={18} color={theme.textFaint} />
        </TouchableOpacity>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {choices.map(c => (
          <TouchableOpacity key={c.id} style={styles.chip} onPress={() => onPick(c.id)} hitSlop={4}
            accessibilityLabel={`Flown with ${c.label}`} testID={`log-aircraft-${c.id}`}>
            <Text style={styles.chipText}>{c.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  )
}

function makeStyles(theme: ScaledTheme) {
  return {
    bar: {
      position: 'absolute' as const, alignSelf: 'center' as const,
      zIndex: 47, maxWidth: 520, marginHorizontal: theme.space3,
      gap: theme.space2,
      backgroundColor: 'rgba(19,24,36,0.94)', borderRadius: theme.radiusLg,
      borderWidth: 1, borderColor: theme.accentBlue,
      paddingHorizontal: theme.space3, paddingVertical: theme.space2,
    },
    head: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.space2 },
    text: { color: theme.textPrimary, fontSize: 13, flexShrink: 1, flexGrow: 1 },
    chips: { gap: theme.space2 },
    chip: {
      paddingHorizontal: theme.space3, paddingVertical: 6, borderRadius: theme.radiusFull,
      backgroundColor: theme.accentBlue,
    },
    chipText: { color: '#0a0e16', fontWeight: '600' as const, fontSize: 13 },
  }
}
