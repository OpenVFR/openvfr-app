/**
 * LoginScreen — passkey (primary) + email OTP (fallback).
 *
 * Passkey flow  (preferred — uses platform biometrics / device PIN):
 *   signInWithPasskey()  →  platform authenticator sheet  →  signed in
 *
 * Email OTP flow (fallback for devices without a passkey registered):
 *   Step 1: enter email → tap "Send code"
 *   Step 2: enter 6-digit code → tap "Sign in"
 *   After first OTP sign-in the user can register a passkey from Settings.
 */

import React, { useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Image,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAuthContext } from '../context/AuthContext'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'

export function LoginScreen() {
  const styles = useThemedStyles(makeStyles)
  const insets                           = useSafeAreaInsets()
  const { sendOtp, verifyOtp, signInWithPasskey, error } = useAuthContext()
  const [email, setEmail]                = useState('')
  const [otp, setOtp]                    = useState('')
  const [step, setStep]                  = useState<'choose' | 'otp'>('choose')
  const [busy, setBusy]                  = useState(false)

  const handlePasskey = async () => {
    setBusy(true)
    await signInWithPasskey()
    setBusy(false)
  }

  const handleSendOtp = async () => {
    if (!email.trim()) return
    setBusy(true)
    const ok = await sendOtp(email.trim().toLowerCase())
    setBusy(false)
    if (ok) setStep('otp')
  }

  const handleVerifyOtp = async () => {
    if (!otp.trim()) return
    setBusy(true)
    await verifyOtp(email.trim().toLowerCase(), otp.trim())
    setBusy(false)
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.card}>
        <Image source={require('../../assets/icon.png')} style={styles.logoImg} />
        <Text style={styles.logo}>OpenVFR</Text>
        <Text style={styles.subtitle}>European VFR Electronic Flight Bag</Text>

        {step === 'choose' && (
          <>
            {/* ── Passkey ──────────────────────────────────────────── */}
            <TouchableOpacity
              style={[styles.btn, styles.btnPasskey, busy && styles.btnDisabled]}
              onPress={handlePasskey}
              disabled={busy}
            >
              {busy
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.btnText}>🔑  Sign in with Passkey</Text>
              }
            </TouchableOpacity>

            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or</Text>
              <View style={styles.dividerLine} />
            </View>

            {/* ── Email OTP ────────────────────────────────────────── */}
            <Text style={styles.label}>Email address</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="pilot@example.com"
              placeholderTextColor={theme.textFaint}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={handleSendOtp}
            />
            <TouchableOpacity
              style={[styles.btn, busy && styles.btnDisabled]}
              onPress={handleSendOtp}
              disabled={busy || !email.trim()}
            >
              {busy
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.btnText}>Send one-time code</Text>
              }
            </TouchableOpacity>
          </>
        )}

        {step === 'otp' && (
          <>
            <Text style={styles.label}>6-digit code sent to {email}</Text>
            <TextInput
              style={[styles.input, styles.otpInput]}
              value={otp}
              onChangeText={setOtp}
              placeholder="000000"
              placeholderTextColor={theme.textFaint}
              keyboardType="number-pad"
              // Not 6: the fixed app-review test OTP (apps/api/src/auth.ts,
              // APP_REVIEW_TEST_OTP) is >= 10 digits and would be truncated,
              // locking store reviewers (and the screenshot CI) out.
              maxLength={32}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleVerifyOtp}
            />
            <TouchableOpacity
              style={[styles.btn, busy && styles.btnDisabled]}
              onPress={handleVerifyOtp}
              disabled={busy}
            >
              {busy
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.btnText}>Sign in</Text>
              }
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.backBtn}
              onPress={() => { setStep('choose'); setOtp('') }}
            >
              <Text style={styles.backBtnText}>← Use a different email</Text>
            </TouchableOpacity>
          </>
        )}

        {error && <Text style={styles.error}>{error}</Text>}

        <Text style={styles.note}>
          Passkey uses your device biometrics or PIN — no password needed.
        </Text>
      </View>
    </KeyboardAvoidingView>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  container: {
    flex:            1,
    backgroundColor: theme.surfaceBase,
    justifyContent:  'center',
    padding:         theme.space4,
  },
  card: {
    backgroundColor: theme.surfacePanel,
    borderRadius:    theme.radiusLg,
    borderWidth:     1,
    borderColor:     theme.borderDefault,
    padding:         theme.space5,
    gap:             theme.space3,
  },
  logoImg: {
    width:        72,
    height:       72,
    borderRadius: 36,
    alignSelf:    'center',
    marginBottom: theme.space2,
  },
  logo: {
    color:      theme.textPrimary,
    fontSize:   theme.text2xl,
    fontWeight: '700',
    textAlign:  'center',
  },
  subtitle: {
    color:        theme.textMuted,
    fontSize:     theme.textSm,
    textAlign:    'center',
    marginBottom: theme.space2,
  },
  label: {
    color:    theme.textSecondary,
    fontSize: theme.textSm,
  },
  input: {
    backgroundColor:   theme.surfaceOverlay,
    borderWidth:       1,
    borderColor:       theme.borderDefault,
    borderRadius:      theme.radiusMd,
    paddingHorizontal: theme.space3,
    paddingVertical:   theme.space3,
    color:             theme.textPrimary,
    fontSize:          theme.textMd,
  },
  otpInput: {
    textAlign:    'center',
    fontSize:     theme.textXl,
    letterSpacing: 8,
    fontWeight:   '700',
  },
  btn: {
    backgroundColor: theme.accentBlue,
    borderRadius:    theme.radiusMd,
    padding:         theme.space3,
    alignItems:      'center',
  },
  btnPasskey: {
    backgroundColor: theme.surfaceOverlay,
    borderWidth:     1,
    borderColor:     theme.accentBlue,
  },
  btnDisabled: {
    opacity: 0.6,
  },
  btnText: {
    color:      '#fff',
    fontSize:   theme.textMd,
    fontWeight: '600',
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           theme.space2,
  },
  dividerLine: {
    flex:            1,
    height:          1,
    backgroundColor: theme.borderSubtle,
  },
  dividerText: {
    color:    theme.textFaint,
    fontSize: theme.textXs,
  },
  backBtn: {
    alignItems: 'center',
    padding:    theme.space2,
  },
  backBtnText: {
    color:    theme.textMuted,
    fontSize: theme.textSm,
  },
  error: {
    color:     theme.statusDanger,
    fontSize:  theme.textSm,
    textAlign: 'center',
  },
  note: {
    color:     theme.textFaint,
    fontSize:  theme.textXs,
    textAlign: 'center',
    marginTop: theme.space1,
  },
} as const
}
