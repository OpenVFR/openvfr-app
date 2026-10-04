/**
 * AerodromeBriefShared — small presentational bits shared between
 * AerodromePopup.tsx (Info/Wx/NOTAM tabs) and the extracted
 * AerodromeWxSection.tsx / AerodromeNotamSection.tsx, so both keep
 * identical section framing and flight-rule/tone colours without each
 * defining their own copy.
 */

import React from 'react'
import { View, Text } from 'react-native'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import type { TileTone } from '@open-vfr/shared/wxFormat'

export const TONE_COLOR: Record<TileTone, string> = {
  ok: theme.accentGreen, warn: theme.statusWarn, danger: theme.statusDanger, info: theme.textSecondary,
}

export const FR_COLOR: Record<string, string> = {
  VFR: '#22c55e', MVFR: '#3b82f6', IFR: '#ef4444', LIFR: '#a855f7',
}

/** Flight-rule badge colours — tinted fill + bright text, same as web's .frVFR/.frMVFR/... */
export const FR_BADGE: Record<string, { bg: string; fg: string }> = {
  VFR:  { bg: 'rgba(34, 197, 94, 0.18)',  fg: '#86efac' },
  MVFR: { bg: 'rgba(59, 130, 246, 0.18)', fg: '#7dd3fc' },
  IFR:  { bg: 'rgba(239, 68, 68, 0.18)',  fg: '#fca5a5' },
  LIFR: { bg: 'rgba(168, 85, 247, 0.18)', fg: '#c084fc' },
}

/** `header` renders inline right of the title (badge, timestamp...). `title` may be omitted when the surrounding tab already names the section. */
export function Section({ title, header, children }: { title?: string; header?: React.ReactNode; children: React.ReactNode }) {
  const sectionStyles = useThemedStyles(makeSectionStyles)
  return (
    <View style={sectionStyles.container}>
      {header ? (
        <View style={sectionStyles.headerRow}>
          {title ? <Text style={[sectionStyles.title, sectionStyles.titleInRow]}>{title.toUpperCase()}</Text> : null}
          {header}
        </View>
      ) : title ? (
        <Text style={sectionStyles.title}>{title.toUpperCase()}</Text>
      ) : null}
      {children}
    </View>
  )
}

function makeSectionStyles(theme: ScaledTheme) {
 return {
  container: {
    marginTop: theme.space2,
    gap:       2,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           theme.space2,
    marginBottom:  theme.space2,
  },
  titleInRow: {
    marginBottom: 0,
  },
  title: {
    color:         theme.textSecondary,
    fontSize:      theme.textSm,
    fontWeight:    '700',
    letterSpacing: 0.8,
    marginBottom:  theme.space2,
  },
} as const
}
