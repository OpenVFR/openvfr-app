/**
 * useUiScale — combined device-size + user-preference scale factor for
 * font/spacing tokens (see styles/theme.ts's useScaledTheme()).
 *
 * Two independent inputs, multiplied together:
 *  1. Device factor: screen width vs. a reference phone width, clamped so a
 *     large dashboard tablet gets modestly bigger UI by default, not
 *     wildly so (a 10" tablet isn't held 6x closer than a phone).
 *  2. User factor: `settings.uiScale`, the manual "Display size" control in
 *     Settings — the deliberate control for cockpit/kneeboard/dashboard
 *     "read from across the cabin" use, independent of OS accessibility
 *     text size (components showing flight-critical numerics should also
 *     set `allowFontScaling={false}` so the two controls don't compound
 *     unpredictably).
 */
import { useWindowDimensions } from 'react-native'
import { useSettingsContext } from '../context/SettingsContext'

/** Reference width: a typical phone in portrait (e.g. iPhone 14/Pixel 7 class). */
const GUIDELINE_WIDTH = 390

const MIN_DEVICE_FACTOR = 0.9
const MAX_DEVICE_FACTOR = 1.35

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

export function useUiScale(): number {
  const { width, height } = useWindowDimensions()
  const { settings } = useSettingsContext()

  // Use the larger dimension so landscape-mounted tablets/dashboards (the
  // common cockpit orientation) also get the device factor's benefit.
  const longSide = Math.max(width, height)
  const deviceFactor = clamp(longSide / GUIDELINE_WIDTH, MIN_DEVICE_FACTOR, MAX_DEVICE_FACTOR)

  return deviceFactor * settings.uiScale
}
