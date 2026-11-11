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
const WRITE_SCOPE = 'aircraft:write'
const ROUTES_WRITE_SCOPE = 'routes:write'

/**
 * What the server can vouch for. An assistant that publishes its identity as
 * a Client ID Metadata Document has its https URL as client id, fetched by
 * the server: its domain is proven. A self-registered assistant has a random
 * id and chose its own name: only where it sends you back is known.
 */
export function assistantIdentity(clientId: string, redirectUri: string | null): { verifiedDomain: string | null; returnsTo: string } {
  let verifiedDomain: string | null = null
  if (/^https:\/\//i.test(clientId)) { try { verifiedDomain = new URL(clientId).host } catch { /* not a URL */ } }
  let returnsTo = 'an unknown address'
  if (redirectUri) {
    try {
      const u = new URL(redirectUri)
      returnsTo = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) ? 'a program on this computer' : u.host
    } catch { returnsTo = 'an app on this device' }
  }
  return { verifiedDomain, returnsTo }
}

function changesText(routes: boolean, aircraft: boolean): string {
  const what = [routes && 'saved routes', aircraft && 'aircraft profiles'].filter(Boolean).join(' and ')
  return what ? `Apart from ${what} it cannot change anything in your account` : 'It cannot change anything in your account'
}

export default function AssistantConsent({ userEmail }: { userEmail: string }) {
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const clientId = params.get('client_id') ?? ''
  const requested = useMemo(() => (params.get('scope') ?? '').split(' ').filter(Boolean), [params])
  const wantsRoutes = requested.includes(ROUTES_SCOPE)
  const wantsWrite = requested.includes(WRITE_SCOPE)
  const wantsRoutesWrite = requested.includes(ROUTES_WRITE_SCOPE)
  const identity = assistantIdentity(clientId, params.get('redirect_uri'))

  const [client, setClient] = useState<AssistantClientInfo | null>(null)
  const [allowRoutes, setAllowRoutes] = useState(wantsRoutes)
  // Changes are never preselected: the pilot opts in.
  const [allowWrite, setAllowWrite] = useState(false)
  const [allowRoutesWrite, setAllowRoutesWrite] = useState(false)
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
      const dropped = new Set<string>()
      if (wantsRoutes && !allowRoutes) dropped.add(ROUTES_SCOPE)
      if (wantsWrite && !allowWrite) dropped.add(WRITE_SCOPE)
      if (wantsRoutesWrite && !allowRoutesWrite) dropped.add(ROUTES_WRITE_SCOPE)
      const scope = accept && dropped.size > 0 ? requested.filter(s => !dropped.has(s)).join(' ') : undefined
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

  // A self-chosen name is quoted: it is only what the assistant calls itself.
  const name = !client?.name ? 'an AI assistant' : identity.verifiedDomain ? client.name : `“${client.name}”`
  return (
    <div className={styles.page}>
      <div className={styles.card} role="dialog" aria-labelledby="consent-title">
        {client?.icon && <img className={styles.icon} src={client.icon} alt="" width={40} height={40} referrerPolicy="no-referrer" />}
        <h1 id="consent-title" className={styles.title}>Connect {name} to OpenVFR?</h1>
        {identity.verifiedDomain ? (
          <p className={styles.verified}>Verified: published by <span className={styles.uri}>{identity.verifiedDomain}</span></p>
        ) : (
          <p className={styles.unverified}>
            Not verified: this assistant registered itself and chose its own name.
            It sends you back to <span className={styles.uri}>{identity.returnsTo}</span>. Only allow it if you just added it yourself.
          </p>
        )}
        <p className={styles.text}>Signed in as <strong>{userEmail}</strong>.</p>
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
        {(wantsWrite || wantsRoutesWrite) && (
          <>
            <p className={styles.text}>It also asks to <strong>make changes</strong> (never delete; you check each change in the app):</p>
            <ul className={styles.list}>
              {wantsRoutesWrite && (
                <li>
                  <label className={styles.check}>
                    <input type="checkbox" checked={allowRoutesWrite} onChange={e => setAllowRoutesWrite(e.target.checked)} disabled={busy} />
                    create and change your saved routes
                  </label>
                </li>
              )}
              {wantsWrite && (
                <li>
                  <label className={styles.check}>
                    <input type="checkbox" checked={allowWrite} onChange={e => setAllowWrite(e.target.checked)} disabled={busy} />
                    add and change your aircraft profiles
                  </label>
                </li>
              )}
            </ul>
          </>
        )}
        <p className={styles.small}>
          {changesText(wantsRoutesWrite && allowRoutesWrite, wantsWrite && allowWrite)}, and it never sees your flight logs or position.
          We email you when an assistant is connected. Disconnect it any time in your account, under
          AI assistants. Only connect assistants you trust: OpenVFR does not check what they do with your data.
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
