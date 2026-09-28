/**
 * NativeSheet -- shared wrapper around @expo/ui's BottomSheet (Compose
 * ModalBottomSheet on Android, SwiftUI sheet on iOS) for every bottom sheet
 * in the app. Centralises the rules learned the hard way so each sheet does
 * not have to rediscover them:
 *
 *  - The React content is hosted in a native view (RNHostView) that does
 *    NOT inherit a bounded height from the sheet. A `flex: 1` ScrollView
 *    inside it is measured at full content height, so it never scrolls and
 *    the sheet clips the bottom. Content therefore always gets an explicit
 *    pixel height here.
 *  - With no `snapPoints`, Android opens the sheet half-height. Tall
 *    scrolling content must use `snapPoints={['full']}` (the default here);
 *    short fixed content passes `height` instead and stays at its own size.
 *  - Sheet colour must be passed explicitly to match the active theme.
 *
 * Modes:
 *  - default: full-height sheet, header + scrolling body.
 *  - `height={n}`: compact sheet of exactly n dp (must be <= about half the
 *    screen, or Android will clip it in the partial state).
 */
import React from 'react'
import { View, Text, TouchableOpacity, ScrollView, useWindowDimensions } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { BottomSheet, RNHostView } from '@expo/ui'
import { theme, useThemedStyles } from '../styles/theme'

interface Props {
  isPresented: boolean
  onDismiss: () => void
  title: string
  children: React.ReactNode
  testID?: string
  /** Overrides the default `${testID}-close` id of the close button. */
  closeTestID?: string
  /** Compact fixed-height sheet (dp). Omit for the full-height sheet. */
  height?: number
  /** Wrap children in a ScrollView (default true). Pass false when children
   *  bring their own scroller (e.g. a FlatList) or need no scrolling. */
  scroll?: boolean
  /** Extra header content rendered left of the close button. */
  headerRight?: React.ReactNode
}

export function NativeSheet({
  isPresented, onDismiss, title, children, testID, closeTestID, height, scroll = true, headerRight,
}: Props) {
  const styles = useThemedStyles(makeStyles)
  const { height: winH } = useWindowDimensions()
  const compact = height != null
  const hostHeight = compact ? height : winH * 0.85

  return (
    <BottomSheet
      isPresented={isPresented}
      onDismiss={onDismiss}
      testID={testID}
      snapPoints={compact ? undefined : ['full']}
      containerColor={theme.surfaceSheet}
    >
      <RNHostView style={{ height: hostHeight }}>
        <View style={[styles.inner, { height: hostHeight }]}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <View style={styles.headerActions}>
              {headerRight}
              <TouchableOpacity
                onPress={onDismiss}
                accessibilityLabel="Close"
                testID={closeTestID ?? (testID ? `${testID}-close` : undefined)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close" size={18} color={theme.textMuted} />
              </TouchableOpacity>
            </View>
          </View>
          {scroll ? (
            <ScrollView
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {children}
              <View style={{ height: 16 }} />
            </ScrollView>
          ) : (
            children
          )}
        </View>
      </RNHostView>
    </BottomSheet>
  )
}

const makeStyles = () => ({
  inner: { flex: 1, paddingBottom: 8 },
  header: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    paddingHorizontal: theme.space4,
    paddingVertical: theme.space2,
    borderBottomWidth: 1,
    borderBottomColor: theme.borderSubtle,
  },
  headerActions: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.space3 },
  title: { color: theme.textPrimary, fontSize: theme.textMd, fontWeight: '700' as const },
})
