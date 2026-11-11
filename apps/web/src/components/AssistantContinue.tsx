/**
 * /oauth/login when the pilot is already signed in: sign-in normally resumes
 * the assistant's authorization request by itself; this is the fallback
 * (e.g. the page was reloaded) that resumes it with one tap.
 */
import { useEffect, useState } from 'react'
import { continueAssistantLogin } from '../hooks/useAuth'
import styles from './AssistantConsent.module.css'

export default function AssistantContinue() {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const go = () => {
    setBusy(true)
    setError('')
    continueAssistantLogin().catch(err => {
      setError(err instanceof Error ? err.message : 'Could not continue. Start the connection from your assistant again.')
      setBusy(false)
    })
  }
  useEffect(go, [])
  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>Connecting your assistant…</h1>
        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.actions}>
          <a className={styles.link} href="/">Open OpenVFR instead</a>
          <button type="button" className={styles.allow} onClick={go} disabled={busy}>Continue</button>
        </div>
      </div>
    </div>
  )
}
