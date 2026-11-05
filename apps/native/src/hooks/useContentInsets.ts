/**
 * useContentInsets — safe-area insets for laying out full-screen content.
 *
 * The iPhone Duo's cover display reports its system rail (clock and status at
 * the top, down the right edge of the portrait screen) as a right inset. Like
 * the status bar of a regular iPhone, only the rail's top is reserved: iOS
 * itself puts the dock and the navigation back button into the rest, and the
 * rail is transparent. Padding everything by it pushed the whole app left, so
 * on such a screen (portrait, right inset only) content gets the full width
 * (`right` is 0) and only controls in the clock's row -- the map's top-right
 * buttons and top banners -- keep clear of it with `railRight`.
 * Landscape notches (left and right insets) are left as they are.
 */

import { useWindowDimensions } from 'react-native'
import { useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context'

export function useContentInsets(): EdgeInsets & { railRight: number } {
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()
  const sideRail = height > width && insets.right > 0 && insets.left === 0
  return sideRail
    ? { ...insets, right: 0, railRight: insets.right }
    : { ...insets, railRight: 0 }
}
