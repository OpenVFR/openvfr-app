/**
 * Consent page of an assistant connection (/oauth/consent).
 *
 * The api's OAuth provider sends the browser here, with a signed copy of the
 * authorization request in the URL, when the pilot's AI assistant asks to
 * connect. The pilot sees which assistant it is and what it may read, and
 * approves or denies; the server then sends the browser back to the
 * assistant. Reading saved routes and aircraft is a separate choice.
 */
import { useEffect, useMemo, useState } from 'react'
import { assistantClientInfo, answerAssistantConsent, type AssistantClientInfo } from '../hooks/useAuth'
import styles from './AssistantConsent.module.css'

const ROUTES_SCOPE = 'routes:read'

export default function AssistantConsent({ userEmail }: { userEmail: string }) {
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const clientId = params.get('client_id') ?? ''
  const requested = useMemo(() => (params.get('scope') ?? '').split(' ').filter(Boolean), [params])
  const wantsRoutes = requested.includes(ROUTES_SCOPE)

  const [client, setClient] = useState<AssistantClientInfo | null>(null)
  const [allowRoutes, setAllowRoutes] = useState(wantsRoutes)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!clientId) return
    assistantClientInfo(clientId).then(setClient).catch(() => setClient(null))
  }, [clientId])

  async function answer(accept: boolean) {
    setBusy(true)
    setError('')
    try {
      const scope = accept && wantsRoutes && !allowRoutes
        ? requested.filter(s => s !== ROUTES_SCOPE).join(' ')
        : undefined
      await answerAssistantConsent(accept, scope)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try connecting again from the assistant.')
      setBusy(false)
    }
  }

  if (!clientId) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <h1 className={styles.title}>Nothing to approve</h1>
          <p className={styles.text}>Start the connection from your AI assistant.</p>
          <a className={styles.link} href="/">Open OpenVFR</a>
        </div>
      </div>
    )
  }

  const name = client?.name ?? 'an AI assistant'
  return (
    <div className={styles.page}>
      <div className={styles.card} role="dialog" aria-labelledby="consent-title">
        {client?.icon && <img className={styles.icon} src={client.icon} alt="" width={40} height={40} referrerPolicy="no-referrer" />}
        <h1 id="consent-title" className={styles.title}>Connect {name} to OpenVFR?</h1>
        <p className={styles.text}>
          Signed in as <strong>{userEmail}</strong>.
          {client?.uri && <> From <span className={styles.uri}>{new URL(client.uri).host}</span>.</>}
        </p>
        <p className={styles.text}>It will be able to <strong>read</strong>:</p>
        <ul className={styles.list}>
          <li>route briefings, aerodrome information, METAR/TAF and NOTAMs</li>
          {wantsRoutes && (
            <li>
              <label className={styles.check}>
                <input type="checkbox" checked={allowRoutes} onChange={e => setAllowRoutes(e.target.checked)} disabled={busy} />
                your saved routes and aircraft profiles
              </label>
            </li>
          )}
        </ul>
        <p className={styles.small}>
          It cannot change anything in your account, and it never sees your flight logs or position.
          Disconnect it any time in your account, under AI assistants. Only connect assistants you trust:
          OpenVFR does not check them.
        </p>
        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.actions}>
          <button type="button" className={styles.deny} onClick={() => answer(false)} disabled={busy}>Deny</button>
          <button type="button" className={styles.allow} onClick={() => answer(true)} disabled={busy}>{busy ? 'Connecting…' : 'Allow'}</button>
        </div>
      </div>
    </div>
  )
}
