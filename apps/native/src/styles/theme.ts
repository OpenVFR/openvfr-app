/**
 * Design tokens — mirrors src/styles/theme.css from the web project.
 * In React Native there is no CSS; tokens are plain TypeScript constants.
 *
 * Colour tokens (surface/text/border/accent/status) come from
 * @open-vfr/shared/uiTheme's UI_THEME_TOKENS, keyed by ThemeName
 * ('dark' | 'light' | 'high-contrast') — same three themes as web, same
 * per-theme colour values. `theme` is a MUTABLE singleton object (not
 * `as const`): setActiveThemeName() mutates its colour properties in place
 * rather than reassigning the export, so every existing `theme.accentBlue`
 * style read (module-scope or inline JSX prop) picks up the new theme on
 * its next render without needing to be rewritten to consume a hook. What
 * *does* need a hook is triggering that next render in the first place —
 * useScaledTheme()/useThemedStyles() subscribe to the active theme name via
 * useSyncExternalStore, so any component already using either (nearly every
 * component that reads `theme.*` also builds its stylesheet with one of
 * these) re-renders on theme change for free.
 *
 * Size tokens (spacing, font size, radius) are scaled at render time via
 * `useScaledTheme()` — see below for why a plain static object doesn't work
 * for those either.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { StyleSheet } from 'react-native'
import type { ImageStyle, TextStyle, ViewStyle } from 'react-native'
import { useUiScale } from '../hooks/useUiScale'
import { UI_THEME_TOKENS, type ThemeName } from '@open-vfr/shared/uiTheme'

export type { ThemeName }

const FIXED_TOKENS = {
  // Airspace class colours live ONLY in @open-vfr/shared/airspaceColors (AC.*),
  // used directly in AviationMap.tsx's AIRSPACE_FILL_COLOR/AIRSPACE_BORDER_COLOR
  // expressions. Do not duplicate them here — a hardcoded copy previously
  // drifted out of sync with web (was missing the CTR-vs-TMA distinction).
  // Airspace colours are also NOT themed — they're the same across dark/
  // light/high-contrast so the map reads consistently regardless of UI theme.

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
}

/** Mutable singleton — see file header. Starts on 'dark'; setActiveThemeName()
 *  mutates the colour keys in place. */
export const theme = {
  ...UI_THEME_TOKENS.dark,
  ...FIXED_TOKENS,
}

export type Theme = typeof theme

// ---------------------------------------------------------------------------
// Active theme store — plain module-level pub/sub, read via
// useSyncExternalStore so components re-render on change without a Context
// provider (theme.* stays a flat static import everywhere else).
// ---------------------------------------------------------------------------
let activeThemeName: ThemeName = 'dark'
const listeners = new Set<() => void>()

export function getActiveThemeName(): ThemeName {
  return activeThemeName
}

/** Call once from SettingsProvider when the persisted theme setting loads or
 *  changes. Mutates the `theme` singleton's colour keys in place and notifies
 *  subscribers (useScaledTheme/useThemedStyles consumers) to re-render. */
export function setActiveThemeName(name: ThemeName): void {
  if (name === activeThemeName) return
  activeThemeName = name
  Object.assign(theme, UI_THEME_TOKENS[name])
  listeners.forEach((l) => l())
}

function subscribeActiveTheme(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function getActiveThemeSnapshot() {
  return activeThemeName
}

export function useActiveThemeName(): ThemeName {
  return useSyncExternalStore(subscribeActiveTheme, getActiveThemeSnapshot)
}

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
  const factor    = useUiScale()
  const themeName = useActiveThemeName()
  return useMemo(() => {
    const scale = (px: number) => Math.round(px * factor)
    const scaled = { ...theme } as Record<string, unknown>
    for (const key of SIZE_KEYS) scaled[key] = scale(theme[key])
    return { ...scaled, scale } as ScaledTheme
    // themeName is read only for its reactive dependency - theme's colour
    // keys are already mutated in place by setActiveThemeName() by the time
    // this recomputes, so themeName itself isn't used in the body.
  }, [factor, themeName])
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
