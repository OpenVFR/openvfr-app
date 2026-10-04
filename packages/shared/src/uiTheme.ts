/**
 * Canonical UI theme colour tokens — single source of truth for web and native.
 *
 * Web (`apps/web/src/styles/theme.css`, `[data-theme="…"]` blocks) and native
 * (`apps/native/src/styles/theme.ts`) both derive their per-theme colour
 * values from here so 'dark' | 'light' | 'high-contrast' look equivalent on
 * both platforms. Web's CSS file has additional fine-grained tokens (alert
 * cards, status boxes, input fields, terrain bands, tints) that have no
 * native equivalent yet — those stay CSS-only (status boxes + the bright-blue
 * accent + selected-pill tint have since moved here; see below). If you add a new colour to
 * one of the CSS theme blocks that native also needs, add it here first and
 * consume it from both sides, don't hardcode a duplicate.
 *
 * Values are plain colour strings (hex or rgba()) — valid CSS and valid
 * React Native `color`/`backgroundColor`/`borderColor` values alike.
 */

export type ThemeName = 'dark' | 'light' | 'high-contrast'

export type UiThemeTokens = {
  // Surfaces
  surfaceBase:    string
  surfacePanel:   string
  surfaceOverlay: string
  surfaceHover:   string

  // Text
  textPrimary:   string
  textSecondary: string
  textMuted:     string
  textFaint:     string

  // Borders
  borderSubtle:  string
  borderDefault: string
  borderStrong:  string

  // Accent
  accentBlue:    string
  accentPurple:  string
  accentMagenta: string
  accentYellow:  string
  accentGreen:   string
  accentCyan:    string
  accentOrange:  string
  accentRed:     string

  // Status
  statusOk:     string
  statusWarn:   string
  statusDanger: string
  statusInfo:   string

  // Status boxes — tinted background + border + text, used for the weather
  // tiles and info banners (same values as web's --status-box-* tokens).
  statusBoxOkBg:     string
  statusBoxOkBorder: string
  statusBoxOkText:   string
  statusBoxWarnBg:     string
  statusBoxWarnBorder: string
  statusBoxWarnText:   string
  statusBoxDangerBg:     string
  statusBoxDangerBorder: string
  statusBoxDangerText:   string
  statusBoxInfoBg:     string
  statusBoxInfoBorder: string
  statusBoxInfoText:   string

  // Brighter accent blue + selected-pill tint (web's --accent-blue-bright / --tint-blue-mid).
  accentBlueBright: string
  tintBlueMid:      string
}

export const UI_THEME_TOKENS: Record<ThemeName, UiThemeTokens> = {
  dark: {
    surfaceBase:    'rgba(10, 14, 22, 0.92)',
    surfacePanel:   'rgba(12, 16, 26, 0.95)',
    surfaceOverlay: 'rgba(10, 14, 22, 0.85)',
    surfaceHover:   'rgba(255, 255, 255, 0.05)',

    textPrimary:   '#e8edf5',
    textSecondary: '#b8c0cc',
    textMuted:     '#8d98a8',
    textFaint:     '#6b7687',

    borderSubtle:  'rgba(255, 255, 255, 0.07)',
    borderDefault: 'rgba(255, 255, 255, 0.10)',
    borderStrong:  'rgba(255, 255, 255, 0.18)',

    accentBlue:    '#93c5fd',
    accentPurple:  '#e040fb',
    accentMagenta: '#e040fb',
    accentYellow:  '#facc15',
    accentGreen:   '#86efac',
    accentCyan:    '#22d3ee',
    accentOrange:  '#fdba74',
    accentRed:     '#fca5a5',

    statusOk:     '#86efac',
    statusWarn:   '#facc15',
    statusDanger: '#fca5a5',
    statusInfo:   '#93c5fd',

    statusBoxOkBg:     'rgba(34, 197, 94, 0.14)',
    statusBoxOkBorder: 'rgba(34, 197, 94, 0.35)',
    statusBoxOkText:   'rgba(134, 239, 172, 0.90)',
    statusBoxWarnBg:     'rgba(234, 179, 8, 0.12)',
    statusBoxWarnBorder: 'rgba(234, 179, 8, 0.35)',
    statusBoxWarnText:   'rgba(253, 224, 71, 0.90)',
    statusBoxDangerBg:     'rgba(239, 68, 68, 0.15)',
    statusBoxDangerBorder: 'rgba(239, 68, 68, 0.35)',
    statusBoxDangerText:   'rgba(252, 165, 165, 0.90)',
    statusBoxInfoBg:     'rgba(59, 130, 246, 0.14)',
    statusBoxInfoBorder: 'rgba(59, 130, 246, 0.35)',
    statusBoxInfoText:   'rgba(147, 197, 253, 0.90)',

    accentBlueBright: '#7dd3fc',
    tintBlueMid:      'rgba(147, 197, 253, 0.18)',
  },

  'high-contrast': {
    surfaceBase:    'rgba(0, 0, 0, 0.98)',
    surfacePanel:   'rgba(8, 8, 12, 0.98)',
    surfaceOverlay: 'rgba(0, 0, 0, 0.95)',
    surfaceHover:   'rgba(255, 255, 255, 0.08)',

    textPrimary:   '#ffffff',
    textSecondary: '#e0e8f0',
    textMuted:     '#b8c8d8',
    textFaint:     '#8da0b0',

    borderSubtle:  'rgba(255, 255, 255, 0.14)',
    borderDefault: 'rgba(255, 255, 255, 0.22)',
    borderStrong:  'rgba(255, 255, 255, 0.40)',

    accentBlue:    '#bae0ff',
    accentPurple:  '#f06fff',
    accentMagenta: '#f06fff',
    accentYellow:  '#ffe066',
    accentGreen:   '#a7f3c0',
    accentCyan:    '#67e8f9',
    accentOrange:  '#ffcd80',
    accentRed:     '#ffbbbb',

    statusOk:     '#a7f3c0',
    statusWarn:   '#ffe066',
    statusDanger: '#ffbbbb',
    statusInfo:   '#bae0ff',

    statusBoxOkBg:     'rgba(34, 197, 94, 0.18)',
    statusBoxOkBorder: 'rgba(34, 197, 94, 0.55)',
    statusBoxOkText:   '#a7f3c0',
    statusBoxWarnBg:     'rgba(234, 179, 8, 0.18)',
    statusBoxWarnBorder: 'rgba(234, 179, 8, 0.55)',
    statusBoxWarnText:   '#ffe066',
    statusBoxDangerBg:     'rgba(239, 68, 68, 0.20)',
    statusBoxDangerBorder: 'rgba(239, 68, 68, 0.55)',
    statusBoxDangerText:   '#ffbbbb',
    statusBoxInfoBg:     'rgba(59, 130, 246, 0.20)',
    statusBoxInfoBorder: 'rgba(59, 130, 246, 0.55)',
    statusBoxInfoText:   '#bae0ff',

    accentBlueBright: '#93d4ff',
    tintBlueMid:      'rgba(147, 197, 253, 0.25)',
  },

  light: {
    surfaceBase:    'rgba(241, 245, 249, 0.96)',
    surfacePanel:   'rgba(248, 250, 252, 0.98)',
    surfaceOverlay: 'rgba(226, 232, 240, 0.92)',
    surfaceHover:   'rgba(0, 0, 0, 0.04)',

    textPrimary:   '#0f172a',
    textSecondary: '#334155',
    textMuted:     '#4e6070',
    textFaint:     '#64748b',

    borderSubtle:  'rgba(0, 0, 0, 0.06)',
    borderDefault: 'rgba(0, 0, 0, 0.10)',
    borderStrong:  'rgba(0, 0, 0, 0.20)',

    accentBlue:    '#2563eb',
    accentPurple:  '#9333ea',
    accentMagenta: '#c026d3',
    accentYellow:  '#ca8a04',
    accentGreen:   '#16a34a',
    accentCyan:    '#0891b2',
    accentOrange:  '#c2410c',
    accentRed:     '#dc2626',

    statusOk:     '#16a34a',
    statusWarn:   '#ca8a04',
    statusDanger: '#dc2626',
    statusInfo:   '#2563eb',

    statusBoxOkBg:     'rgba(22, 163, 74, 0.10)',
    statusBoxOkBorder: 'rgba(22, 163, 74, 0.30)',
    statusBoxOkText:   '#166534',
    statusBoxWarnBg:     'rgba(161, 98, 7, 0.10)',
    statusBoxWarnBorder: 'rgba(161, 98, 7, 0.30)',
    statusBoxWarnText:   '#92400e',
    statusBoxDangerBg:     'rgba(220, 38, 38, 0.10)',
    statusBoxDangerBorder: 'rgba(220, 38, 38, 0.30)',
    statusBoxDangerText:   '#b91c1c',
    statusBoxInfoBg:     'rgba(37, 99, 235, 0.08)',
    statusBoxInfoBorder: 'rgba(37, 99, 235, 0.28)',
    statusBoxInfoText:   '#1d4ed8',

    accentBlueBright: '#0ea5e9',
    tintBlueMid:      'rgba(37, 99, 235, 0.15)',
  },
}
