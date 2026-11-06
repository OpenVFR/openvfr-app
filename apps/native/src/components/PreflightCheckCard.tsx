/**
 * Pre-flight Check card for the plan screen: the shared route warnings (red /
 * yellow / blue) and prompts (blue reminders), with "Show on map" and, for a
 * leg below its minimum safe altitude, "Raise to". Mirrors the web drawer
 * section (apps/web/src/components/PreflightWarnings.tsx).
 */
import React from 'react'
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native'
import type { PreflightWarning } from '@open-vfr/shared/preflightWarnings'
import type { PreflightPrompt } from '@open-vfr/shared/preflightPrompts'
import { useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'

type Props = {
  warnings: PreflightWarning[]
  prompts: PreflightPrompt[]
  loading: boolean
  onShowOnMap: (w: PreflightWarning) => void
  onRaiseLeg: (legIndex: number, altFt: number) => void
}

export function PreflightCheckCard({ warnings, prompts, loading, onShowOnMap, onRaiseLeg }: Props) {
  const theme = useScaledTheme()
  const styles = useThemedStyles(makeStyles)
  const problems = warnings.some((w) => w.level !== 'info')
  const edge = (level: PreflightWarning['level']) =>
    level === 'danger' ? theme.statusDanger : level === 'warn' ? theme.statusWarn : theme.statusInfo

  return (
    <View style={styles.card} testID="preflight-card">
      <Text style={styles.title}>PRE-FLIGHT CHECK</Text>
      {loading && (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={theme.textFaint} />
          <Text style={styles.detail}>Checking route…</Text>
        </View>
      )}
      {!loading && !problems && <Text style={styles.ok}>✓ No issues found</Text>}
      {warnings.map((w, i) => {
        const fix = w.fix
        return (
        <View key={`${w.code}-${i}`} style={[styles.item, { borderLeftColor: edge(w.level) }]}>
          <Text style={styles.itemTitle}>
            <Text style={{ color: edge(w.level) }}>{w.level === 'danger' ? '✕ ' : w.level === 'info' ? 'i ' : '! '}</Text>
            {w.title}
          </Text>
          <Text style={styles.detail}>{w.detail}</Text>
          <View style={styles.actions}>
            {w.focusNm != null && (
              <TouchableOpacity onPress={() => onShowOnMap(w)} style={styles.btn} accessibilityRole="button">
                <Text style={styles.btnTxt}>Show on map</Text>
              </TouchableOpacity>
            )}
            {fix?.kind === 'raise-leg' && (
              <TouchableOpacity onPress={() => onRaiseLeg(fix.legIndex, fix.altFt)} style={styles.btn} accessibilityRole="button">
                <Text style={styles.btnTxt}>Raise to {fix.altFt.toLocaleString('en-US')} ft</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
        )
      })}
      {prompts.map((p) => (
        <View key={p.code} style={[styles.item, { borderLeftColor: theme.statusInfo }]}>
          <Text style={styles.itemTitle}><Text style={{ color: theme.statusInfo }}>i </Text>{p.title}</Text>
          <Text style={styles.detail}>{p.detail}</Text>
        </View>
      ))}
    </View>
  )
}

const makeStyles = (theme: ScaledTheme) => ({
  card: {
    margin: theme.space3, marginTop: 0, padding: theme.space3, gap: theme.space2,
    backgroundColor: theme.surfacePanel, borderRadius: theme.radiusMd,
    borderWidth: 1, borderColor: theme.borderSubtle,
  },
  title: { color: theme.textFaint, fontSize: theme.textXs, fontWeight: '700', letterSpacing: 0.8 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space2 },
  ok: { color: theme.accentGreen, fontSize: theme.textSm },
  item: { borderLeftWidth: 3, paddingLeft: theme.space2, paddingVertical: theme.space1, gap: 2 },
  itemTitle: { color: theme.textPrimary, fontSize: theme.textSm, fontWeight: '600' },
  detail: { color: theme.textMuted, fontSize: theme.textXs },
  actions: { flexDirection: 'row', gap: theme.space2, marginTop: theme.space1 },
  btn: {
    paddingHorizontal: theme.space2, paddingVertical: theme.space1,
    borderRadius: theme.radiusSm, borderWidth: 1, borderColor: theme.borderSubtle,
  },
  btnTxt: { color: theme.textPrimary, fontSize: theme.textXs, fontWeight: '600' },
} as const)
