/**
 * AerodromeNotamSection — the NOTAMs-tab content extracted verbatim from
 * AerodromePopup.tsx, so it can be reused wherever a single aerodrome's
 * NOTAM list needs the exact same display without a full aerodrome tap
 * (e.g. VicinityBriefSheet.tsx's NOTAM tab).
 *
 * Fully self-contained: owns its own expand/collapse state per NOTAM id.
 */

import React, { useState } from 'react'
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import { fmtNotamDate, type NotamItem } from '@open-vfr/shared/fetchNotam'
import { Section } from './AerodromeBriefShared'

interface Props {
  notams:       NotamItem[]
  notamLoading: boolean
}

export default function AerodromeNotamSection({ notams, notamLoading }: Props) {
  const styles = useThemedStyles(makeStyles)
  const [expandedNotams, setExpandedNotams] = useState<Set<string>>(new Set())

  function toggleNotam(id: string) {
    setExpandedNotams((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <Section title={`NOTAMs${notams.length > 0 ? ` (${notams.length})` : ''}`}>
      {notamLoading && <ActivityIndicator size="small" color={theme.accentBlue} />}
      {!notamLoading && notams.length === 0 && (
        <Text style={styles.muted}>No NOTAMs</Text>
      )}
      {notams.map((n) => {
        const expanded = expandedNotams.has(n.id)
        return (
          <TouchableOpacity key={n.id} style={styles.notamRow} onPress={() => toggleNotam(n.id)}>
            <Text style={styles.notamId}>{n.id} {expanded ? '▴' : '▾'}</Text>
            {n.effective && (
              <Text style={styles.notamDate}>{fmtNotamDate(n.effective)} → {fmtNotamDate(n.expires)}</Text>
            )}
            {expanded && <Text style={styles.notamText}>{n.text}</Text>}
          </TouchableOpacity>
        )
      })}
    </Section>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  muted: {
    color:    theme.textSecondary,
    fontSize: theme.textSm,
    fontStyle: 'italic',
  },
  notamRow: {
    gap:          3,
    paddingVertical: theme.space2,
    borderBottomWidth: 1,
    borderBottomColor: theme.borderSubtle,
  },
  notamId: {
    color:      theme.accentBlue,
    fontSize:   theme.textMd,
    fontWeight: '700',
  },
  notamDate: {
    color:    theme.textSecondary,
    fontSize: theme.textXs,
  },
  notamText: {
    color:    theme.textSecondary,
    fontSize: theme.textSm,
    lineHeight: 17,
    marginTop: 2,
  },
} as const
}
