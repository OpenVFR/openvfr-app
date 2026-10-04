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
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, useWindowDimensions, Linking,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAuthContext } from '../context/AuthContext'
import { SITE_BASE } from '../config'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'

/** Map raw auth/network errors to short, actionable text. null = stay silent. */
function friendlyError(raw: string | null): string | null {
  if (!raw) return null
  const m = raw.toLowerCase()
  if (/cancel|abort|dismiss|not allowed/.test(m)) return null
  if (/network|fetch failed|unable to resolve|timed? ?out|offline/.test(m))
    return 'No connection. Check your internet and try again.'
  if (/invalid|incorrect|expired/.test(m)) return 'That code is invalid or has expired. Request a new one.'
  if (/too many|rate/.test(m)) return 'Too many attempts. Wait a minute and try again.'
  if (/passkey|credential|webauthn/.test(m))
    return 'Passkey sign-in failed. Use an email code instead.'
  return raw
}

export function LoginScreen() {
  const styles = useThemedStyles(makeStyles)
  const insets                           = useSafeAreaInsets()
  const { width }                        = useWindowDimensions()
  // Logo scales with device width (capped so tablets don't get a giant one).
  const logoSize                         = Math.round(Math.min(width * 0.6, 320))
  const { sendOtp, verifyOtp, signInWithPasskey, passkeySupported, error } = useAuthContext()
  const [email, setEmail]                = useState('')
  const [otp, setOtp]                    = useState('')
  const [step, setStep]                  = useState<'choose' | 'otp'>('choose')
  const [busy, setBusy]                  = useState(false)

  const shownError = friendlyError(error)

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
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
      <View style={styles.card}>
        <Image
          source={require('../../assets/icon.png')}
          style={[styles.logoImg, { width: logoSize, height: logoSize, borderRadius: logoSize / 2 }]}
        />
        <Text style={styles.logo}>OpenVFR</Text>
        <Text style={styles.subtitle}>European VFR Electronic Flight Bag</Text>

        {step === 'choose' && (
          <>
            {/* ── Passkey (hidden when the OS has no passkey support) ── */}
            {passkeySupported && (<>
            <TouchableOpacity
              style={[styles.btn, styles.btnSecondary, busy && styles.btnDisabled]}
              testID="login-passkey"
              accessibilityRole="button"
              accessibilityLabel="Sign in with passkey"
              onPress={handlePasskey}
              disabled={busy}
            >
              {busy
                ? <ActivityIndicator color="#fff" />
                : (
                  <View style={styles.btnRow}>
                    <Ionicons name="key" size={22} color="#FACC15" />
                    <Text style={styles.btnText} numberOfLines={1} adjustsFontSizeToFit>
                      Sign in with passkey
                    </Text>
                  </View>
                )
              }
            </TouchableOpacity>
            <Text style={styles.hint}>
              Uses your device biometrics or PIN — no password needed.
            </Text>

            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>OR</Text>
              <View style={styles.dividerLine} />
            </View>
            </>)}

            {/* ── Email OTP ────────────────────────────────────────── */}
            <TextInput
              style={styles.input}
              testID="login-email"
              value={email}
              onChangeText={setEmail}
              placeholder="Email address"
              accessibilityLabel="Email address"
              placeholderTextColor={theme.textFaint}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              returnKeyType="send"
              onSubmitEditing={handleSendOtp}
            />
            <TouchableOpacity
              style={[styles.btn, styles.btnSecondary, (busy || !email.trim()) && styles.btnDisabled]}
              testID="login-send-otp"
              onPress={handleSendOtp}
              disabled={busy || !email.trim()}
            >
              {busy
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.btnText}>Continue with email</Text>
              }
            </TouchableOpacity>
          </>
        )}

        {step === 'otp' && (
          <>
            <Text style={styles.label}>6-digit code sent to {email}</Text>
            <TextInput
              style={[styles.input, styles.otpInput]}
              testID="login-otp"
              value={otp}
              onChangeText={setOtp}
              placeholder="000000"
              placeholderTextColor={theme.textFaint}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              // Not 6: the fixed app-review test OTP (apps/api/src/auth.ts,
              // APP_REVIEW_TEST_OTP) is >= 10 digits and would be truncated,
              // locking store reviewers (and the screenshot CI) out.
              maxLength={32}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleVerifyOtp}
            />
            <TouchableOpacity
              style={[styles.btn, (busy || !otp.trim()) && styles.btnDisabled]}
              testID="login-verify-otp"
              onPress={handleVerifyOtp}
              disabled={busy || !otp.trim()}
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
            <TouchableOpacity style={styles.backBtn} onPress={handleSendOtp} disabled={busy}>
              <Text style={styles.backBtnText}>Resend code</Text>
            </TouchableOpacity>
          </>
        )}

        {shownError && <Text style={styles.error} testID="login-error">{shownError}</Text>}

        {!!SITE_BASE && (
        <View style={styles.footer}>
          <Text style={styles.footerLink} onPress={() => Linking.openURL(`${SITE_BASE}/privacy`)}>
            Privacy
          </Text>
          <Text style={styles.footerDot}>·</Text>
          <Text style={styles.footerLink} onPress={() => Linking.openURL(`${SITE_BASE}/terms`)}>
            Terms & Disclaimer
          </Text>
        </View>
        )}
      </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  container: {
    flex:            1,
    backgroundColor: theme.surfaceBase,
  },
  scroll: {
    flexGrow:        1,
    justifyContent:  'center',
    padding:         theme.space4,
  },
  card: {
    gap:             theme.space3,
    width:           '100%',
    maxWidth:        480,
    alignSelf:       'center',
  },
  logoImg: {
    alignSelf:    'center',
    marginBottom: theme.space3,
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
    fontSize:          theme.textSm,
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
    paddingVertical: theme.space3,
    paddingHorizontal: theme.space3,
    minHeight:       52,
    justifyContent:  'center',
    alignItems:      'center',
  },
  btnSecondary: {
    backgroundColor: theme.surfaceOverlay,
    borderWidth:     2,
    borderColor:     theme.accentBlue,
  },
  btnRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           theme.space2,
    maxWidth:      '100%',
  },
  btnDisabled: {
    opacity: 0.6,
  },
  btnText: {
    flexShrink: 1,
    color:      '#fff',
    fontSize:   theme.textMd,
    fontWeight: '600',
  },
  dividerRow: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            theme.space3,
    marginVertical: theme.space3,
  },
  dividerLine: {
    flex:            1,
    height:          2,
    borderRadius:    1,
    backgroundColor: theme.textFaint,
    opacity:         0.6,
  },
  dividerText: {
    color:         theme.textSecondary,
    fontSize:      theme.textSm,
    fontWeight:    '700',
    letterSpacing: 2,
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
  hint: {
    color:     theme.textFaint,
    fontSize:  theme.textXs,
    textAlign: 'center',
    marginTop: -theme.space1,
  },
  footer: {
    flexDirection:  'row',
    justifyContent: 'center',
    alignItems:     'center',
    gap:            theme.space2,
    marginTop:      theme.space4,
  },
  footerLink: {
    color:              theme.textMuted,
    fontSize:           theme.textXs,
    textDecorationLine: 'underline',
    padding:            theme.space1,
  },
  footerDot: {
    color:    theme.textFaint,
    fontSize: theme.textXs,
  },
} as const
}
