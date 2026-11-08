/**
 * PasskeyPromptModal — offers passkey registration right after an email-code
 * sign-in, for accounts that have none. Rules and back-off live in
 * @open-vfr/shared/passkeyPrompt; Settings -> Account keeps the permanent row.
 */
import React, { useEffect, useState } from 'react'
import { Modal, View, Text, TouchableOpacity, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { shouldOfferPasskey, canOfferNever, type PasskeyPromptState } from '@open-vfr/shared/passkeyPrompt'
import { useAuthContext } from '../context/AuthContext'
import { useSettingsContext } from '../context/SettingsContext'
import { useInternalBarometer } from '../hooks/useInternalBarometer'
import { API_BASE } from '../config'
import { authHeaders } from '../utils/authClient'
import { listPasskeys } from '../utils/passkeyNative'
import { consumeOtpSignIn, loadPromptState, recordDismissal } from '../utils/passkeyPrompt'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'

export function PasskeyPromptModal() {
  const { state, registerPasskey, passkeySupported } = useAuthContext()
  const styles = useThemedStyles(makeStyles)
  // First run shows the barometer offer too; never stack two sheets. Wait until
  // it is answered or the device has no sensor.
  const { settings, loaded } = useSettingsContext()
  const baro = useInternalBarometer(false)
  const baroOfferPending =
    !loaded || baro.availability === 'checking' ||
    (!settings.baroPromptSeen && !settings.useInternalBarometer && baro.availability === 'available')
  const userId = state.status === 'authenticated' ? state.user.id : null
  const [prompt, setPrompt] = useState<PasskeyPromptState | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!userId || !passkeySupported || !consumeOtpSignIn()) return
    let alive = true
    void (async () => {
      try {
        const saved = await loadPromptState(userId)
        if (!shouldOfferPasskey(saved, Date.now())) return
        // Accounts that cannot hold passkeys (shared test/review accounts).
        const flags = await fetch(`${API_BASE}/api/auth/account-flags`, { headers: await authHeaders() })
        if (flags.ok && (await flags.json() as { passkeyAllowed?: boolean }).passkeyAllowed === false) return
        if ((await listPasskeys()).length > 0) return
        if (alive) setPrompt(saved)
      } catch { /* offline or unexpected: stay silent, Settings still has it */ }
    })()
    return () => { alive = false }
  }, [userId, passkeySupported])

  if (!prompt || !userId || baroOfferPending) return null

  const close = (never = false) => {
    if (!done) void recordDismissal(userId, prompt, never)
    setPrompt(null); setMessage(null); setDone(false)
  }

  const setUp = async () => {
    setBusy(true); setMessage(null)
    try {
      const res = await registerPasskey()
      if (res.ok) setDone(true)
      else if (res.cancelled) close()
      else setMessage(res.message ?? 'Could not set up the passkey.')
    } finally { setBusy(false) }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => close()}>
      <View style={styles.backdrop}>
        <View style={styles.card} testID="passkey-prompt">
          <Ionicons name="key" size={32} color={theme.accentBlue} />
          {done ? (
            <>
              <Text style={styles.title}>Passkey added</Text>
              <Text style={styles.body}>Next time, tap “Sign in with passkey” instead of waiting for a code.</Text>
              <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={() => close()}>
                <Text style={styles.btnPrimaryText}>Done</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.title}>Sign in faster next time</Text>
              <Text style={styles.body}>
                Use your fingerprint, face or screen lock instead of waiting for an email code. It takes a few seconds to set up.
              </Text>
              {!!message && <Text style={styles.error}>{message}</Text>}
              <TouchableOpacity style={[styles.btn, styles.btnPrimary, busy && styles.disabled]} disabled={busy} onPress={setUp} testID="passkey-prompt-setup">
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnPrimaryText}>Set up passkey</Text>}
              </TouchableOpacity>
              <TouchableOpacity style={styles.btn} disabled={busy} onPress={() => close()} testID="passkey-prompt-later">
                <Text style={styles.btnText}>Not now</Text>
              </TouchableOpacity>
              {canOfferNever(prompt) && (
                <TouchableOpacity disabled={busy} onPress={() => close(true)}>
                  <Text style={styles.never}>Don’t ask again</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>
      </View>
    </Modal>
  )
}

function makeStyles(theme: ScaledTheme) {
  return {
    backdrop: { flex: 1, justifyContent: 'center' as const, padding: theme.space4, backgroundColor: 'rgba(0,0,0,0.6)' },
    card: {
      padding: theme.space4, gap: theme.space3, borderRadius: theme.radiusLg, alignItems: 'center' as const,
      backgroundColor: theme.surfacePanel, borderWidth: 1, borderColor: theme.borderDefault,
    },
    title: { color: theme.textPrimary, fontSize: theme.textXl, fontWeight: '700' as const, textAlign: 'center' as const },
    body:  { color: theme.textSecondary, fontSize: theme.textSm, lineHeight: 20, textAlign: 'center' as const },
    error: { color: theme.statusDanger, fontSize: theme.textSm, textAlign: 'center' as const },
    btn: {
      alignSelf: 'stretch' as const, alignItems: 'center' as const, minHeight: 44, justifyContent: 'center' as const,
      borderRadius: theme.radiusMd, borderWidth: 1, borderColor: theme.borderDefault, paddingHorizontal: theme.space3,
    },
    btnPrimary: { backgroundColor: theme.accentBlue, borderColor: theme.accentBlue },
    btnText: { color: theme.textPrimary, fontSize: theme.textMd, fontWeight: '600' as const },
    btnPrimaryText: { color: '#fff', fontSize: theme.textMd, fontWeight: '600' as const },
    never: { color: theme.textMuted, fontSize: theme.textSm, padding: theme.space2, textDecorationLine: 'underline' as const },
    disabled: { opacity: 0.6 },
  } as const
}
