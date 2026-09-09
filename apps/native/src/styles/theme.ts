/**
 * Design tokens — mirrors src/styles/theme.css from the web project.
 * In React Native there is no CSS; tokens are plain TypeScript constants.
 */
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

  // Spacing scale
  space0: 2,
  space1: 4,
  space2: 8,
  space3: 12,
  space4: 16,
  space5: 20,
  space6: 24,

  // Font sizes
  textXs:  10,
  textSm:  12,
  textMd:  14,
  textLg:  16,
  textXl:  20,
  text2xl: 24,

  // Border radii
  radiusSm: 4,
  radiusMd: 8,
  radiusLg: 12,
  radiusFull: 999,
} as const

export type Theme = typeof theme
