/**
 * Design tokens — mirrors src/styles/theme.css from the web project.
 * In React Native there is no CSS; tokens are plain TypeScript constants.
 *
 * Colours are fixed and exported directly as `theme`. Size tokens (spacing,
 * font size, radius) are scaled at render time via `useScaledTheme()` — see
 * below for why a plain static object doesn't work for those.
 */
import { useMemo } from 'react'
import { StyleSheet } from 'react-native'
import type { ImageStyle, TextStyle, ViewStyle } from 'react-native'
import { useUiScale } from '../hooks/useUiScale'

export const theme = {
  // Surfaces
  surfaceBase:    '#0a0e16',
  surfacePanel:   '#131824',
  surfaceOverlay: '#1b2236',
  surfaceHover:   '#1f2940',

  // Text
  textPrimary:   '#e8eaf0',
  textSecondary: '#a0a8be',
  textMuted:     '#6b7491',
  textFaint:     '#4a5070',

  // Borders
  borderSubtle:  '#1e2640',
  borderDefault: '#2a3354',
  borderStrong:  '#3a4570',

  // Accent
  accentBlue:    '#3b82f6',
  accentPurple:  '#a855f7',
  accentMagenta: '#e040fb',
  accentYellow:  '#f59e0b',
  accentGreen:   '#22c55e',
  accentCyan:    '#06b6d4',
  accentOrange:  '#f97316',
  accentRed:     '#ef4444',

  // Status
  statusOk:     '#22c55e',
  statusWarn:   '#f59e0b',
  statusDanger: '#ef4444',
  statusInfo:   '#3b82f6',

  // Airspace class colours live ONLY in @open-vfr/shared/airspaceColors (AC.*),
  // used directly in AviationMap.tsx's AIRSPACE_FILL_COLOR/AIRSPACE_BORDER_COLOR
  // expressions. Do not duplicate them here — a hardcoded copy previously
  // drifted out of sync with web (was missing the CTR-vs-TMA distinction).

  // Border radii — not scaled (radius is a shape detail, not a legibility
  // concern at distance; scaling it looks wrong on tight controls at high
  // uiScale values).
  radiusSm: 4,
  radiusMd: 8,
  radiusLg: 12,
  radiusFull: 999,

  // --- Size tokens below are the UNSCALED base values. Components must not
  // read these directly for fontSize/spacing — use useScaledTheme() instead,
  // which multiplies them by the device/user scale factor. They stay here so
  // useScaledTheme() has a single base to scale from. ---
  space0: 2,
  space1: 4,
  space2: 8,
  space3: 12,
  space4: 16,
  space5: 20,
  space6: 24,

  textXs:  10,
  textSm:  12,
  textMd:  14,
  textLg:  16,
  textXl:  20,
  text2xl: 24,
} as const

export type Theme = typeof theme

const SIZE_KEYS = [
  'space0', 'space1', 'space2', 'space3', 'space4', 'space5', 'space6',
  'textXs', 'textSm', 'textMd', 'textLg', 'textXl', 'text2xl',
] as const

export type ScaledTheme = Theme & {
  /** Scale an arbitrary raw px value (e.g. a one-off `fontSize: 9` not
   *  covered by a named token) by the current device/user factor. Round to
   *  avoid sub-pixel blur on some Android renderers. */
  scale: (px: number) => number
}

/**
 * useScaledTheme — the ONLY place components should read font/space tokens
 * from. Multiplies base tokens by useUiScale()'s combined device+user
 * factor and memoizes the result, so it's safe to pass into a `useMemo`
 * dependency array for a StyleSheet built inside a component (see the
 * `StyleSheet.create()` static-capture gotcha in AGENTS.md — this hook
 * exists specifically so per-component styles can react to scale changes,
 * unlike the plain `theme` export above).
 */
export function useScaledTheme(): ScaledTheme {
  const factor = useUiScale()
  return useMemo(() => {
    const scale = (px: number) => Math.round(px * factor)
    const scaled = { ...theme } as Record<string, unknown>
    for (const key of SIZE_KEYS) scaled[key] = scale(theme[key])
    return { ...scaled, scale } as ScaledTheme
  }, [factor])
}

type NamedStyles<T> = { [P in keyof T]: ViewStyle | TextStyle | ImageStyle }

/**
 * useThemedStyles — replaces a module-scope `StyleSheet.create({...theme.X...})`
 * call. Module-scope StyleSheet.create captures theme values once at import
 * time (see the static-capture gotcha in AGENTS.md), which breaks live
 * uiScale changes. This hook rebuilds (and memoizes) the stylesheet only
 * when the scaled theme actually changes, using `theme` from its callback
 * argument instead of the static import.
 *
 * Usage: `const styles = useThemedStyles(theme => ({ row: { padding: theme.space2 } }))`
 */
export function useThemedStyles<T extends NamedStyles<T> | NamedStyles<unknown>>(
  factory: (theme: ScaledTheme) => T,
): T {
  const scaledTheme = useScaledTheme()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => StyleSheet.create(factory(scaledTheme)), [scaledTheme])
}
