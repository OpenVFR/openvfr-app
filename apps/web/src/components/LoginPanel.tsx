/**
 * LoginPanel — shown as a full-screen overlay when the user is not signed in.
 *
 * Auth flow:
 *   1. Passkey (primary — WebAuthn modal).
 *   2. Email OTP (fallback) — enter email → receive 6-digit code → enter code.
 */

import { useState, useEffect, useRef } from 'react'
import { shouldAutoSubmitOtp } from '@open-vfr/shared/otpAutoSubmit'
import type { AuthState } from '../hooks/useAuth'
import { SITE_BASE_URL } from '../utils/env'
import styles from './LoginPanel.module.css'

/** WebAuthn available in this browser (hides the passkey option when not). */
const PASSKEY_SUPPORTED = typeof window !== 'undefined' && 'PublicKeyCredential' in window

/** Map raw auth/network errors to short, actionable text. */
function friendlyError(raw: string, fallback: string): string {
  const m = raw.toLowerCase()
  if (/failed to fetch|network|timed? ?out|offline/.test(m))
    return 'No connection. Check your internet and try again.'
  if (/invalid|incorrect|expired/.test(m)) return 'That code is invalid or has expired. Request a new one.'
  if (/too many|rate/.test(m)) return 'Too many attempts. Wait a minute and try again.'
  return raw || fallback
}

interface Props {
  auth: AuthState
}

export default function LoginPanel({ auth }: Props) {
  const [email,     setEmail]     = useState('')
  const [otp,       setOtp]       = useState('')
  const [name,      setName]      = useState('')
  const [step,      setStep]      = useState<'email' | 'otp' | 'setup'>('email')
  const [busy,      setBusy]      = useState(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [statusOk,  setStatusOk]  = useState(false)
  const otpRef  = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const setStatus = (msg: string, ok: boolean) => {
    setStatusMsg(msg)
    setStatusOk(ok)
  }

  // Focus OTP input automatically when we enter that step.
  useEffect(() => {
    if (step === 'otp')   otpRef.current?.focus()
    if (step === 'setup') nameRef.current?.focus()
  }, [step])

  // When the user just signed in for the first time, name will be ''. Show setup.
  useEffect(() => {
    if (auth.user && !auth.user.name) setStep('setup')
  }, [auth.user])

  const handlePasskey = async () => {
    setBusy(true)
    setStatusMsg(null)
    try {
      await auth.signInPasskey()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Passkey sign-in failed'
      if (msg === 'NO_PASSKEY') {
        // Browsers report "cancelled" and "no credential" identically by design.
        setStatus('No passkey found on this device. Continue with email, then add one in Settings.', false)
      } else {
        setStatus(friendlyError(msg, 'Passkey sign-in failed'), false)
      }
    } finally {
      setBusy(false)
    }
  }

  const handleSendOtp = async () => {
    const trimmed = email.trim()
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setStatus('Enter a valid email address', false)
      return
    }
    setBusy(true)
    setStatusMsg(null)
    try {
      await auth.sendOtp(trimmed)
      setStep('otp')
      setStatus('Code sent — check your inbox', true)
    } catch (err) {
      setStatus(friendlyError(err instanceof Error ? err.message : '', 'Failed to send code'), false)
    } finally {
      setBusy(false)
    }
  }

  // Auto sign-in only when autofill/paste fills exactly 6 digits in one go;
  // typed digits never submit (the app-review code is longer than 6).
  const onOtpChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '')
    setOtp(digits)
    if (!busy && shouldAutoSubmitOtp(otp, digits)) void handleSignInOtp(digits)
  }

  const handleSignInOtp = async (explicit?: string) => {
    const code = (explicit ?? otp).trim()
    // >= 6, not === 6: real OTPs are always exactly 6 digits, but the fixed
    // app-review test OTP (apps/api/src/auth.ts, APP_REVIEW_TEST_OTP) is
    // >= 10 digits by design (see that file's comment) -- an exact-6 check
    // here would silently block the test account from ever signing in,
    // same bug class the input's maxLength={32} below was already raised
    // to avoid, just left unfixed on this guard.
    if (code.length < 6) {
      setStatus('Enter the 6-digit code from your email', false)
      return
    }
    setBusy(true)
    setStatusMsg(null)
    try {
      await auth.signInOtp(email.trim(), code)
    } catch (err) {
      setStatus(friendlyError(err instanceof Error ? err.message : '', 'Invalid code'), false)
    } finally {
      setBusy(false)
    }
  }

  const handleBack = () => {
    setStep('email')
    setOtp('')
    setStatusMsg(null)
  }

  const handleSaveName = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setStatus('Enter your name', false)
      return
    }
    setBusy(true)
    setStatusMsg(null)
    try {
      await auth.updateUser({ name: trimmed })
      // auth.user.name is now set → App.tsx unmounts this panel
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Failed to save name', false)
      setBusy(false)
    }
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.panel}>
        {/* Logo / title */}
        <div className={styles.logo}>
          <img src="/pwa-512x512.png" alt="" className={styles.logoImg} width={512} height={512} />
          <h1>OpenVFR</h1>
          <p>Open-Source VFR Flight Planning & Navigation</p>
        </div>

        {/* Setup step — collect name after first sign-in */}
        {step === 'setup' ? (
          <div className={styles.setupBlock}>
            <p className={styles.setupTitle}>One last thing</p>
            <p className={styles.otpHint}>What should we call you?</p>
            <div className={styles.emailRow}>
              <input
                ref={nameRef}
                className={styles.emailInput}
                type="text"
                placeholder="Firstname Lastname"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !busy && void handleSaveName()}
                disabled={busy}
              />
              <button
                className={styles.btnSecondary}
                onClick={() => void handleSaveName()}
                disabled={busy || !name.trim()}
              >
                Continue
              </button>
            </div>
          </div>
        ) : (
          <>
        {PASSKEY_SUPPORTED && (
          <>
            {/* Passkey — primary */}
            <div className={styles.passkeyBlock}>
              <button
                className={styles.btnOutline}
                onClick={() => void handlePasskey()}
                disabled={busy}
              >
                <svg className={styles.keyIcon} viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="currentColor" d="M7 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm5.65-4A6 6 0 1 0 12.65 14H17v4h4v-4h2v-4H12.65Z" />
                </svg>
                Sign in with passkey
              </button>
              <p className={styles.passkeyHint}>Needs a passkey set up on this device.</p>
            </div>

            <div className={styles.divider}>OR</div>
          </>
        )}

        {/* Email OTP — fallback, two steps */}
        {step === 'email' ? (
          <div className={styles.emailStack}>
            <input
              className={styles.emailInput}
              type="email"
              placeholder="Email address"
              aria-label="Email address"
              autoComplete="username webauthn"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && void handleSendOtp()}
              disabled={busy}
            />
            <button
              className={styles.btnOutline}
              onClick={() => void handleSendOtp()}
              disabled={busy || !email.trim()}
            >
              Continue with email
            </button>
          </div>
        ) : (
          <div className={styles.otpBlock}>
            <p className={styles.otpHint}>
              OTP code sent, check your email.
            </p>
            <div className={styles.emailRow}>
              <input
                ref={otpRef}
                className={styles.otpInput}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                // Not 6: the fixed app-review test OTP (apps/api/src/auth.ts,
                // APP_REVIEW_TEST_OTP) is >= 10 digits and would be truncated.
                maxLength={32}
                placeholder="123456"
                autoComplete="one-time-code"
                value={otp}
                onChange={(e) => onOtpChange(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !busy && void handleSignInOtp()}
                disabled={busy}
              />
              <button
                className={styles.btnSecondary}
                onClick={() => void handleSignInOtp()}
                disabled={busy || otp.trim().length < 6}
              >
                Sign in
              </button>
            </div>
            <button
              className={styles.backLink}
              onClick={handleBack}
              type="button"
              disabled={busy}
            >
              ← Use a different email
            </button>
            <button
              className={styles.backLink}
              onClick={() => void handleSendOtp()}
              type="button"
              disabled={busy}
            >
              Resend code
            </button>
          </div>
        )}

          </>
        )}

        {/* Status line */}
        <p className={`${styles.status} ${statusOk ? styles.statusOk : styles.statusErr}`}>
          {statusMsg ?? '\u00a0'}
        </p>

        {step !== 'setup' && (
          <p className={styles.hint}>
            Sign in once — your routes, aircraft, and settings sync across all your devices.
          </p>
        )}

        {SITE_BASE_URL && (
          <nav className={styles.footer} aria-label="Legal">
            <a href={`${SITE_BASE_URL}/privacy`} target="_blank" rel="noopener noreferrer">Privacy</a>
            <span aria-hidden="true">·</span>
            <a href={`${SITE_BASE_URL}/terms`} target="_blank" rel="noopener noreferrer">Terms &amp; Disclaimer</a>
          </nav>
        )}
      </div>
    </div>
  )
}
