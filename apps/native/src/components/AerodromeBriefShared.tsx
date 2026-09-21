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

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const sectionStyles = useThemedStyles(makeSectionStyles)
  return (
    <View style={sectionStyles.container}>
      <Text style={sectionStyles.title}>{title.toUpperCase()}</Text>
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
  title: {
    color:         theme.textSecondary,
    fontSize:      theme.textSm,
    fontWeight:    '700',
    letterSpacing: 0.8,
    marginBottom:  theme.space2,
  },
} as const
}
