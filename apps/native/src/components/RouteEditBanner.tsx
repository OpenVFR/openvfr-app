/**
 * RouteEditBanner — compact pill just above the vertical profile for the whole
 * duration of a route edit session (first edit in planning mode until
 * Apply/Cancel). Distance and ETE are shown in the profile header. Apply
 * keeps the changes as an unsaved working copy; Cancel restores the route as
 * it was before the first edit.
 */

import React from 'react'
import { View, TouchableOpacity } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'

export function RouteEditBanner({
  bottom, canUndo, canRedo,
  onUndo, onRedo, onCancel, onApply,
}: {
  bottom: number
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onCancel: () => void
  onApply: () => void
}) {
  const styles = useThemedStyles(makeStyles)
  return (
    <View style={[styles.bar, { bottom }]} testID="route-edit-banner">
      <TouchableOpacity onPress={onUndo} disabled={!canUndo} hitSlop={8} accessibilityLabel="Undo">
        <Ionicons name="arrow-undo" size={18} color={canUndo ? theme.textPrimary : theme.textFaint} />
      </TouchableOpacity>
      <TouchableOpacity onPress={onRedo} disabled={!canRedo} hitSlop={8} accessibilityLabel="Redo">
        <Ionicons name="arrow-redo" size={18} color={canRedo ? theme.textPrimary : theme.textFaint} />
      </TouchableOpacity>
      <TouchableOpacity style={styles.cancelBtn} onPress={onCancel} hitSlop={6} testID="route-edit-cancel" accessibilityLabel="Cancel changes">
        <Ionicons name="close" size={18} color={theme.textPrimary} />
      </TouchableOpacity>
      <TouchableOpacity style={styles.applyBtn} onPress={onApply} hitSlop={6} testID="route-edit-apply" accessibilityLabel="Apply changes">
        <Ionicons name="checkmark" size={18} color="#0b1220" />
      </TouchableOpacity>
    </View>
  )
}

function makeStyles(theme: ScaledTheme) {
  return {
    bar: {
      position: 'absolute' as const, left: theme.space2,
      zIndex: 46,
      flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.space3,
      backgroundColor: 'rgba(19,24,36,0.94)', borderRadius: theme.radiusFull,
      borderWidth: 1, borderColor: '#22d3ee',
      paddingLeft: theme.space3, paddingRight: theme.space2, paddingVertical: theme.space1,
    },
    cancelBtn: {
      width: 30, height: 30, borderRadius: 15, alignItems: 'center' as const, justifyContent: 'center' as const,
      backgroundColor: 'rgba(255,255,255,0.12)',
    },
    applyBtn: {
      width: 30, height: 30, borderRadius: 15, alignItems: 'center' as const, justifyContent: 'center' as const,
      backgroundColor: '#22d3ee',
    },
  }
}
