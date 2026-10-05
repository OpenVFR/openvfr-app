/**
 * BaroPromptModal — one-time first-run offer to enable the phone's internal
 * barometer. Shown only when the sensor is detected, the pilot hasn't already
 * enabled it, and the prompt hasn't been answered before. Either answer is
 * remembered (settings.baroPromptSeen); the Settings toggle stays the
 * single place to change it later. No OS permission is involved.
 */

import React from 'react'
import { Modal, View, Text, TouchableOpacity } from 'react-native'
import { useSettingsContext } from '../context/SettingsContext'
import { useInternalBarometer } from '../hooks/useInternalBarometer'
import { useThemedStyles, type ScaledTheme } from '../styles/theme'

export function BaroPromptModal() {
  const { settings, update, loaded } = useSettingsContext()
  const baro = useInternalBarometer(false)
  const styles = useThemedStyles(makeStyles)

  const visible =
    loaded &&
    !settings.baroPromptSeen &&
    !settings.useInternalBarometer &&
    baro.availability === 'available'

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => update({ baroPromptSeen: true })}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Use phone barometer?</Text>
          <Text style={styles.body}>
            This device has a barometric sensor. Using it gives smoother, faster-reacting
            altitude than GPS, plus a vertical-speed (VS) readout.
          </Text>
          <Text style={styles.heading}>Limitations</Text>
          <Text style={styles.body}>
            {'• Measures pressure at the phone: cabin pressure, vents, a pocket or a case can cause drift and spikes.\n'}
            {'• Altitude depends on QNH. Keep QNH set (auto from nearest METAR by default).\n'}
            {'• The phone sensor updates about once a second, so VS lags a few seconds.\n'}
            {'• Slightly higher battery use.\n'}
            {'• On iPhone, iOS will ask for Motion & Fitness access. It is only used to read the pressure sensor.\n'}
            {'• Advisory only. Not a certified altimeter.'}
          </Text>
          <Text style={styles.body}>
            A BlueFly Vario (Bluetooth, external vented sensor) is faster and more
            accurate for VS, and is always preferred over the phone barometer when connected: Settings → Vario.
          </Text>
          <View style={styles.actions}>
            <TouchableOpacity style={styles.btn} onPress={() => update({ baroPromptSeen: true })}>
              <Text style={styles.btnText}>Not now</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary]}
              onPress={() => update({ baroPromptSeen: true, useInternalBarometer: true })}
            >
              <Text style={[styles.btnText, styles.btnPrimaryText]}>Enable</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>You can change this anytime in Settings.</Text>
        </View>
      </View>
    </Modal>
  )
}

function makeStyles(theme: ScaledTheme) {
  return {
    backdrop: {
      flex: 1, justifyContent: 'center' as const, padding: theme.space4,
      backgroundColor: 'rgba(0,0,0,0.6)',
    },
    card: {
      padding: theme.space4, gap: theme.space2, borderRadius: theme.radiusLg,
      backgroundColor: theme.surfacePanel, borderWidth: 1, borderColor: theme.borderDefault,
    },
    title:   { color: theme.textPrimary, fontSize: theme.textXl, fontWeight: '700' as const },
    heading: { color: theme.textPrimary, fontSize: theme.textMd, fontWeight: '700' as const },
    body:    { color: theme.textSecondary, fontSize: theme.textSm, lineHeight: 18 },
    hint:    { color: theme.textSecondary, fontSize: theme.textXs, textAlign: 'center' as const },
    actions: { flexDirection: 'row' as const, justifyContent: 'flex-end' as const, gap: theme.space2, marginTop: theme.space2 },
    btn: {
      paddingVertical: theme.space2, paddingHorizontal: theme.space4,
      borderRadius: theme.radiusSm, borderWidth: 1, borderColor: theme.borderDefault,
    },
    btnText: { color: theme.textPrimary, fontSize: theme.textMd, fontWeight: '600' as const },
    btnPrimary: { backgroundColor: theme.accentBlue, borderColor: theme.accentBlue },
    btnPrimaryText: { color: '#fff' },
  } as const
}
