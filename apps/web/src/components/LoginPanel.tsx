/**
 * LoginPanel — shown as a full-screen overlay when the user is not signed in.
 *
 * Auth flow:
 *   1. Passkey (primary — WebAuthn modal).
 *   2. Email OTP (fallback) — enter email → receive 6-digit code → enter code.
 */

import { useState, useEffect, useRef } from 'react'
import type { AuthState } from '../hooks/useAuth'
import styles from './LoginPanel.module.css'

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
        setStatus('No passkey found on this device — sign in with email instead.', false)
      } else {
        setStatus(msg, false)
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
      setStatus(err instanceof Error ? err.message : 'Failed to send code', false)
    } finally {
      setBusy(false)
    }
  }

  const handleSignInOtp = async () => {
    const code = otp.trim()
    if (code.length !== 6) {
      setStatus('Enter the 6-digit code from your email', false)
      return
    }
    setBusy(true)
    setStatusMsg(null)
    try {
      await auth.signInOtp(email.trim(), code)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Invalid code', false)
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
          <h1>Open VFR</h1>
          <p>European VFR Electronic Flight Bag</p>
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
        {/* Passkey — primary */}
        <button
          className={styles.btnPrimary}
          onClick={() => void handlePasskey()}
          disabled={busy}
        >
          Sign in with passkey
        </button>

        <div className={styles.divider}>or</div>

        {/* Email OTP — fallback, two steps */}
        {step === 'email' ? (
          <div className={styles.emailRow}>
            <input
              className={styles.emailInput}
              type="email"
              placeholder="pilot@example.com"
              autoComplete="username webauthn"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && void handleSendOtp()}
              disabled={busy}
            />
            <button
              className={styles.btnSecondary}
              onClick={() => void handleSendOtp()}
              disabled={busy || !email.trim()}
            >
              Send code
            </button>
          </div>
        ) : (
          <div className={styles.otpBlock}>
            <p className={styles.otpHint}>
              Enter the 6-digit code sent to <strong>{email}</strong>
            </p>
            <div className={styles.emailRow}>
              <input
                ref={otpRef}
                className={styles.otpInput}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="123456"
                autoComplete="one-time-code"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && !busy && void handleSignInOtp()}
                disabled={busy}
              />
              <button
                className={styles.btnSecondary}
                onClick={() => void handleSignInOtp()}
                disabled={busy || otp.trim().length !== 6}
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
      </div>
    </div>
  )
}
