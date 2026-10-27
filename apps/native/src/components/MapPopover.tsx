/**
 * MapPopover — a small bubble anchored to a spot on the map (a route point
 * or leg), drawn above it with a tail so the spot itself stays visible.
 * Holds a short title and a few icon actions, or just a line of text. Used
 * instead of a sheet for quick route actions (Details / Direct to / Remove)
 * and route hints ("drag the middle to add a point").
 */

import React from 'react'
import { View, Text, TouchableOpacity, useWindowDimensions } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useThemedStyles, type ScaledTheme } from '../styles/theme'

export interface MapPopoverAction {
  key: string
  icon: React.ComponentProps<typeof Ionicons>['name']
  /** Short text next to the icon (optional; icon-only otherwise). */
  label?: string
  accessibilityLabel: string
  onPress: () => void
  danger?: boolean
}

const BUBBLE_H = 40
const TAIL = 8
/** Gap between the anchor and the tail tip: clears a route point's ring. */
const ANCHOR_GAP = 16

export function MapPopover({ x, y, title, text, actions = [], testID }: {
  /** Anchor in the map container's coordinates (dp). */
  x: number
  y: number
  title?: string
  text?: string
  actions?: MapPopoverAction[]
  testID?: string
}) {
  const styles = useThemedStyles(makeStyles)
  const { width: winW } = useWindowDimensions()
  const [w, setW] = React.useState(0)
  // Above the anchor; below it when there is no room at the top.
  const above = y - ANCHOR_GAP - TAIL - BUBBLE_H > 8
  const top = above ? y - ANCHOR_GAP - TAIL - BUBBLE_H : y + ANCHOR_GAP + TAIL
  const left = Math.max(8, Math.min(winW - w - 8, x - w / 2))
  const tailLeft = Math.max(12, Math.min(w - 12, x - left)) - TAIL
  return (
    <View
      style={[styles.wrap, { top, left, opacity: w ? 1 : 0 }]}
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      testID={testID}
    >
      <View style={styles.bubble}>
        {title ? <Text style={styles.title} numberOfLines={1}>{title}</Text> : null}
        {text ? <Text style={styles.text} numberOfLines={2}>{text}</Text> : null}
        {actions.map((a) => (
          <TouchableOpacity
            key={a.key}
            style={styles.action}
            onPress={a.onPress}
            hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
            accessibilityRole="button"
            accessibilityLabel={a.accessibilityLabel ?? a.label}
            testID={`${testID ?? 'popover'}-${a.key}`}
          >
            <Ionicons name={a.icon} size={18} color={a.danger ? '#f87171' : '#22d3ee'} />
            {a.label ? <Text style={[styles.actionTxt, a.danger && styles.dangerTxt]}>{a.label}</Text> : null}
          </TouchableOpacity>
        ))}
      </View>
      <View style={[styles.tail, above ? styles.tailDown : styles.tailUp, { left: tailLeft }, above ? { top: BUBBLE_H - 1 } : { top: -TAIL + 1 }]} />
    </View>
  )
}

function makeStyles(theme: ScaledTheme) {
  return {
    wrap: { position: 'absolute' as const, zIndex: 47 },
    bubble: {
      height: BUBBLE_H, maxWidth: 360,
      flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.space2,
      paddingHorizontal: theme.space3,
      backgroundColor: 'rgba(19,24,36,0.96)', borderRadius: theme.radiusMd,
      borderWidth: 1, borderColor: '#22d3ee',
    },
    title: { color: '#e5e7eb', fontSize: theme.textSm, fontWeight: '700' as const, maxWidth: 140 },
    text: { color: '#e5e7eb', fontSize: theme.textXs, fontWeight: '600' as const, maxWidth: 260 },
    // At least 44 wide (touch target guidance), icon-only actions included.
    action: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 4, paddingHorizontal: 8, minWidth: 44, height: BUBBLE_H },
    actionTxt: { color: '#22d3ee', fontSize: theme.textXs, fontWeight: '700' as const },
    dangerTxt: { color: '#f87171' },
    tail: {
      position: 'absolute' as const, width: 0, height: 0,
      borderLeftWidth: TAIL, borderRightWidth: TAIL,
      borderLeftColor: 'transparent', borderRightColor: 'transparent',
    },
    tailDown: { borderTopWidth: TAIL, borderTopColor: '#22d3ee' },
    tailUp: { borderBottomWidth: TAIL, borderBottomColor: '#22d3ee' },
  }
}
