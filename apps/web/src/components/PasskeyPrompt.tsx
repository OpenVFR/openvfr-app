/**
 * PasskeyPrompt — offers passkey registration right after an email-code
 * sign-in, for accounts that have none. Rules and back-off live in
 * @open-vfr/shared/passkeyPrompt; Settings keeps the permanent entry.
 */
import { useEffect, useState } from 'react'
import {
  shouldOfferPasskey, canOfferNever, peekOtpSignIn, consumeOtpSignIn, type PasskeyPromptState,
} from '@open-vfr/shared/passkeyPrompt'
import type { AuthState } from '../hooks/useAuth'
import { fetchPasskeyAllowed, loadPromptState, recordDismissal } from '../utils/passkeyPrompt'
import css from './PasskeyPrompt.module.css'

const PASSKEY_SUPPORTED = typeof window !== 'undefined' && 'PublicKeyCredential' in window

export default function PasskeyPrompt({ auth }: { auth: AuthState }) {
  const userId = auth.user?.id ?? null
  const [prompt, setPrompt] = useState<PasskeyPromptState | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const { listPasskeys } = auth
  useEffect(() => {
    if (!userId || !PASSKEY_SUPPORTED || !peekOtpSignIn()) return
    let alive = true
    void (async () => {
      let offer: PasskeyPromptState | null = null
      try {
        const saved = loadPromptState(userId)
        if (shouldOfferPasskey(saved, Date.now()) && await fetchPasskeyAllowed() && (await listPasskeys()).length === 0) offer = saved
      } catch { /* offline or unexpected: stay silent */ }
      if (!alive) return          // aborted before deciding: leave the flag for the next run
      consumeOtpSignIn()
      if (offer) setPrompt(offer)
    })()
    return () => { alive = false }
  }, [userId, listPasskeys])

  if (!prompt || !userId) return null

  const close = (never = false) => {
    if (!done) recordDismissal(userId, prompt, never)
    setPrompt(null); setMessage(null); setDone(false)
  }

  const setUp = async () => {
    setBusy(true); setMessage(null)
    try {
      await auth.registerPasskey()
      setDone(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      // Browsers report "cancelled" and failures alike; treat as "Not now".
      if (/cancel|abort|not allowed/i.test(msg)) close()
      else setMessage(msg || 'Could not set up the passkey.')
    } finally { setBusy(false) }
  }

  return (
    <div className={css.backdrop} role="dialog" aria-modal="true" aria-labelledby="passkey-prompt-title">
      <div className={css.card}>
        {done ? (
          <>
            <h2 id="passkey-prompt-title" className={css.title}>Passkey added</h2>
            <p className={css.body}>Next time, choose “Sign in with passkey” instead of waiting for a code.</p>
            <button className={css.primary} onClick={() => close()}>Done</button>
          </>
        ) : (
          <>
            <h2 id="passkey-prompt-title" className={css.title}>Sign in faster next time</h2>
            <p className={css.body}>
              Use your fingerprint, face or screen lock instead of waiting for an email code. It takes a few seconds to set up.
            </p>
            {message && <p className={css.error}>{message}</p>}
            <button className={css.primary} onClick={() => void setUp()} disabled={busy}>Set up passkey</button>
            <button className={css.secondary} onClick={() => close()} disabled={busy}>Not now</button>
            {canOfferNever(prompt) && (
              <button className={css.never} onClick={() => close(true)} disabled={busy}>Don’t ask again</button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
