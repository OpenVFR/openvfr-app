/**
 * MapToolbar — one 3×3 dot-grid "Map tools" button that opens a compact tile
 * menu with grouped sections (Flying / Find & look up / Map tools). Replaces
 * the former column of separate home, find-destination, brief, ruler, route
 * lock and flight-mode buttons. Mirrors the web toolbar (MapToolbar.tsx).
 *
 * The menu is a transparent Modal anchored under the button, so it is not
 * clipped by the scrolling control column. Closes on selection or an outside
 * tap. Touch has no hover: each tile carries its description as the
 * accessibility hint (screen readers), and long-press shows it inline.
 */

import React, { useRef, useState, type ReactNode } from 'react'
import { Modal, Pressable, ScrollView, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native'
import IconGridDots from '@tabler/icons-react-native/IconGridDots'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'

export interface ToolItem {
  id: string
  label: string
  /** One-sentence description: what it does and how it behaves. */
  description: string
  /** Receives the colour to draw with (active / dim aware). */
  icon: (color: string) => ReactNode
  active?: boolean
  dim?: boolean
  /** Keep the menu open after selecting. */
  keepOpen?: boolean
  onSelect: () => void
}

export interface ToolGroupDef {
  id: string
  label: string
  items: ToolItem[]
}

const MENU_GAP = 6
const MENU_TILE_W = 86

export function MapToolbar({ groups }: { groups: ToolGroupDef[] }) {
  const styles = useThemedStyles(makeStyles)
  const { width: winW, height: winH } = useWindowDimensions()
  // Landscape has the width but not the height: lay the sections out side by side
  // (more columns) and scroll if it still doesn't fit, instead of running off the bottom.
  const landscape = winW > winH
  const btnRef = useRef<View>(null)
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  const anyActive = groups.some(g => g.items.some(i => i.active))

  const openMenu = () => {
    btnRef.current?.measureInWindow((x, y, w, h) => {
      setHint(null)
      setAnchor({ top: y + h + MENU_GAP, right: Math.max(0, winW - (x + w)) })
    })
  }
  const close = () => { setAnchor(null); setHint(null) }

  return (
    <>
      <TouchableOpacity
        ref={btnRef}
        style={[styles.btn, anyActive && styles.btnActive]}
        onPress={() => (anchor ? close() : openMenu())}
        accessibilityRole="button"
        accessibilityLabel="Map tools"
        accessibilityHint="Find places, ruler, route editing and flying mode"
        accessibilityState={{ expanded: !!anchor }}
        testID="map-tools-open"
      >
        <IconGridDots size={20} strokeWidth={2} color={anyActive ? theme.accentBlue : theme.textPrimary} />
      </TouchableOpacity>

      <Modal visible={!!anchor} transparent animationType="fade" onRequestClose={close} supportedOrientations={['portrait', 'landscape']}>
        <Pressable style={styles.backdrop} onPress={close} accessibilityLabel="Close map tools" />
        {anchor && (
          <View style={[styles.menu, { top: anchor.top, right: anchor.right, maxWidth: winW - 16, maxHeight: winH - anchor.top - 8 }]} testID="map-tools-menu">
            <ScrollView
              contentContainerStyle={landscape ? styles.sectionsRow : styles.sectionsCol}
              showsVerticalScrollIndicator={false}
            >
            {groups.map(g => (
              <View key={g.id} style={styles.section}>
                <Text style={styles.heading}>{g.label}</Text>
                <View style={styles.grid}>
                  {g.items.map(it => {
                    const color = it.active ? theme.accentBlue : theme.textPrimary
                    return (
                      <TouchableOpacity
                        key={it.id}
                        style={[styles.tile, it.active && styles.tileActive, it.dim && styles.dim]}
                        onPress={() => { it.onSelect(); if (!it.keepOpen) close() }}
                        onLongPress={() => setHint(`${it.label} — ${it.description}`)}
                        accessibilityRole="menuitem"
                        accessibilityLabel={it.label}
                        accessibilityHint={it.description}
                        accessibilityState={{ selected: !!it.active }}
                        testID={`map-tool-${it.id}`}
                      >
                        {it.icon(color)}
                        <Text style={[styles.tileLabel, it.active && { color: theme.accentBlue }]} numberOfLines={2}>{it.label}</Text>
                      </TouchableOpacity>
                    )
                  })}
                </View>
              </View>
            ))}
            </ScrollView>
            {hint && <Text style={styles.hint}>{hint}</Text>}
          </View>
        )}
      </Modal>
    </>
  )
}

function makeStyles(t: ScaledTheme) {
  return {
    btn: {
      width:           40,
      height:          40,
      borderRadius:    t.radiusMd,
      backgroundColor: 'rgba(19,24,36,0.90)',
      borderWidth:     1,
      borderColor:     t.borderDefault,
      alignItems:      'center' as const,
      justifyContent:  'center' as const,
    },
    btnActive: { borderColor: t.accentBlue },
    backdrop:  { ...{ position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 } },
    menu: {
      position:        'absolute' as const,
      backgroundColor: t.surfaceSheet,
      borderRadius:    t.radiusLg,
      borderWidth:     1,
      borderColor:     t.borderDefault,
      padding:         t.space2,
      gap:             t.space2,
    },
    sectionsCol: { gap: t.space2 },
    // Landscape: two rows. Flying (up to 2 tiles) + Find & look up (3) fit on the first
    // row; Map tools wraps onto the second. Width is capped at 5 tiles + gaps.
    sectionsRow: {
      flexDirection: 'row' as const,
      flexWrap:      'wrap' as const,
      alignItems:    'flex-start' as const,
      columnGap:     t.space3,
      rowGap:        t.space2,
      maxWidth:      MENU_TILE_W * 5 + t.space1 * 3 + t.space3 + 2,
    },
    section:  { gap: t.space1 },
    heading:  {
      color:         t.textFaint,
      fontSize:      t.scale(8),
      fontWeight:    '700' as const,
      letterSpacing: 0.6,
      textTransform: 'uppercase' as const,
      paddingHorizontal: t.space1,
    },
    grid:     { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: t.space1 },
    tile: {
      width:           MENU_TILE_W,
      minHeight:       58,
      borderRadius:    t.radiusMd,
      backgroundColor: t.surfaceOverlay,
      borderWidth:     1,
      borderColor:     t.borderSubtle,
      alignItems:      'center' as const,
      justifyContent:  'center' as const,
      gap:             t.space1,
      paddingHorizontal: t.space1,
      paddingVertical:   t.space2,
    },
    tileActive: { borderColor: t.accentBlue },
    dim:        { opacity: 0.5 },
    tileLabel:  { color: t.textPrimary, fontSize: t.scale(9), fontWeight: '600' as const, textAlign: 'center' as const },
    hint: {
      color:      t.textMuted,
      fontSize:   t.textXs,
      lineHeight: 16,
      maxWidth:   MENU_TILE_W * 3 + t.space1 * 2,
      paddingHorizontal: t.space1,
    },
  }
}
