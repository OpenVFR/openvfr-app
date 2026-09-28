/**
 * NativeSheet -- the app's single bottom-sheet component. Thin wrapper over
 * `@expo/ui/community/bottom-sheet` (a gorhom-compatible API on top of the
 * platform sheets: SwiftUI sheet on iOS, Material 3 ModalBottomSheet on
 * Android).
 *
 * Sizing follows the standard "dynamic sizing" pattern: no snap points, the
 * sheet is exactly as tall as its content, and tall content scrolls inside a
 * ScrollView whose `maxHeight` caps the sheet at MAX_FRACTION of the window.
 * Short sheets stay short; long ones (filters, lists) grow to the cap and
 * scroll. No fixed pixel heights, no measuring state.
 *
 * Lessons this wrapper encodes (each cost a debugging round):
 *  - Content hosted in the native sheet gets no bounded height, so a
 *    `flex: 1` ScrollView never scrolls. Use `maxHeight` on the scroller.
 *  - Sheet colour must be passed explicitly (backgroundStyle) to match the
 *    active theme.
 *  - The sheet is mounted only while presented. Pan-down / back / scrim /
 *    the close button all end in `onClose`, which the caller maps to
 *    `setOpen(false)`.
 */
import React, { useEffect, useRef, useState } from 'react'
import {
  View, Text, TouchableOpacity, ScrollView, useWindowDimensions, Keyboard,
  type StyleProp, type ViewStyle,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import BottomSheet, { type BottomSheetMethods } from '@expo/ui/community/bottom-sheet'
import { theme, useThemedStyles } from '../styles/theme'

/** Tallest a sheet may grow, as a fraction of the window height. */
const MAX_FRACTION = 0.85
/** Header height guess used until the real chrome height is measured. */
const CHROME_GUESS = 64

/**
 * Height a sheet may occupy: MAX_FRACTION of the window minus any visible
 * keyboard. The native sheet moves up above the keyboard but does not shrink
 * its content, so without this a tall sheet gets its header pushed off the
 * top of the screen while typing. Sheets with their own inner lists should
 * derive that list's maxHeight from this too.
 */
export function useKeyboardHeight(): number {
  const [kbH, setKbH] = useState(0)
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (e) => setKbH(e.endCoordinates.height))
    const hide = Keyboard.addListener("keyboardDidHide", () => setKbH(0))
    return () => { show.remove(); hide.remove() }
  }, [])
  return kbH
}

export function useSheetMaxHeight(): number {
  const { height: winH } = useWindowDimensions()
  const kbH = useKeyboardHeight()
  return (winH - kbH) * MAX_FRACTION
}

interface Props {
  isPresented: boolean
  onDismiss: () => void
  /** Default header title. Ignored when `header` is provided. */
  title?: string
  /** Fully custom header (must include its own close control). */
  header?: React.ReactNode
  /** Fixed content between header and scroll area (e.g. a tab bar). */
  fixedTop?: React.ReactNode
  contentContainerStyle?: StyleProp<ViewStyle>
  children: React.ReactNode
  testID?: string
  /** Overrides the default `${testID}-close` id of the close button. */
  closeTestID?: string
  /** Wrap children in a ScrollView (default true). Pass false when children
   *  bring their own bounded scroller. */
  scroll?: boolean
  /** Extra header content rendered left of the close button. */
  headerRight?: React.ReactNode
}

export function NativeSheet({
  isPresented, onDismiss, title, header, fixedTop, contentContainerStyle, children,
  testID, closeTestID, scroll = true, headerRight,
}: Props) {
  const styles = useThemedStyles(makeStyles)
  const sheetMaxH = useSheetMaxHeight()
  const kbH = useKeyboardHeight()
  const sheetRef = useRef<BottomSheetMethods>(null)
  const [chromeH, setChromeH] = React.useState(CHROME_GUESS)
  if (!isPresented) return null

  const close = () => sheetRef.current?.close()
  const maxScrollH = sheetMaxH - chromeH

  return (
    <BottomSheet
      ref={sheetRef}
      index={0}
      enableDynamicSizing
      enablePanDownToClose
      onClose={onDismiss}
      backgroundStyle={{ backgroundColor: theme.surfaceSheet }}
    >
      <View testID={testID}>
        <View onLayout={(e) => setChromeH(e.nativeEvent.layout.height)}>
          {header ?? (
            <View style={styles.header}>
              <Text style={styles.title}>{title}</Text>
              <View style={styles.headerActions}>
                {headerRight}
                <TouchableOpacity
                  onPress={close}
                  accessibilityLabel="Close"
                  testID={closeTestID ?? (testID ? `${testID}-close` : undefined)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="close" size={18} color={theme.textMuted} />
                </TouchableOpacity>
              </View>
            </View>
          )}
          {fixedTop}
        </View>
        {scroll ? (
          <ScrollView
            style={{ maxHeight: maxScrollH }}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={contentContainerStyle}
          >
            {children}
            {/* Extra room while typing so the last fields can scroll above the keyboard. */}
            <View style={{ height: 24 + kbH }} />
          </ScrollView>
        ) : (
          children
        )}
      </View>
    </BottomSheet>
  )
}

const makeStyles = () => ({
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
