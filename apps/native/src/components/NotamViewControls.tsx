/**
 * Native NOTAM list controls: Short / Full / Raw segmented toggle + "VFR
 * only" chip, backed by the shared useNotamPrefs store (mirrors web's
 * NotamViewControls).
 */
import React from 'react'
import { View, Text, TouchableOpacity } from 'react-native'
import type { NotamTextView } from '@open-vfr/shared/notamIcaoFormat'
import { useThemedStyles, type ScaledTheme } from '../styles/theme'
import { useNotamPrefs } from '../hooks/useNotamPrefs'

const VIEWS: { v: NotamTextView; label: string }[] = [
  { v: 'short', label: 'Short' },
  { v: 'full',  label: 'Full' },
  { v: 'raw',   label: 'Raw' },
]

export default function NotamViewControls({ showVfr = true }: { showVfr?: boolean }) {
  const styles = useThemedStyles(makeStyles)
  const { textView, setTextView, vfrOnly, setVfrOnly } = useNotamPrefs()
  return (
    <View style={styles.row}>
      <View style={styles.seg} accessibilityRole="radiogroup" accessibilityLabel="NOTAM text view">
        {VIEWS.map(({ v, label }, i) => (
          <TouchableOpacity
            key={v}
            onPress={() => setTextView(v)}
            style={[styles.segBtn, i > 0 && styles.segSep, textView === v && styles.segOn]}
            accessibilityRole="radio"
            accessibilityState={{ selected: textView === v }}
          >
            <Text style={[styles.segTxt, textView === v && styles.segTxtOn]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {showVfr && (
        <TouchableOpacity
          onPress={() => setVfrOnly(!vfrOnly)}
          style={[styles.chip, vfrOnly && styles.chipOn]}
          accessibilityRole="switch"
          accessibilityState={{ checked: vfrOnly }}
        >
          <Text style={[styles.chipTxt, vfrOnly && styles.chipTxtOn]}>VFR only</Text>
        </TouchableOpacity>
      )}
    </View>
  )
}

function makeStyles(theme: ScaledTheme) {
  return {
    row:      { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.space2, marginBottom: theme.space2 },
    seg:      { flexDirection: 'row' as const, borderWidth: 1, borderColor: theme.borderDefault, borderRadius: theme.radiusSm, overflow: 'hidden' as const },
    segBtn:   { paddingHorizontal: theme.space2, paddingVertical: 4 },
    segSep:   { borderLeftWidth: 1, borderLeftColor: theme.borderDefault },
    segOn:    { backgroundColor: theme.surfacePanel },
    segTxt:   { color: theme.textMuted, fontSize: theme.textXs, fontWeight: '600' as const },
    segTxtOn: { color: theme.textPrimary },
    chip:     { paddingHorizontal: theme.space2, paddingVertical: 4, borderWidth: 1, borderColor: theme.borderDefault, borderRadius: theme.radiusSm },
    chipOn:   { borderColor: theme.accentBlue },
    chipTxt:  { color: theme.textMuted, fontSize: theme.textXs, fontWeight: '600' as const },
    chipTxtOn:{ color: theme.accentBlue },
  }
}
