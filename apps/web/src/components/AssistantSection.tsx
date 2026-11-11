/**
 * Account panel section "AI assistants": how to connect the pilot's own AI
 * assistant (the server's MCP address and a few steps per assistant), and the
 * assistants already connected, each with Disconnect. Shown only when the
 * server offers the assistant connection (account-flags assistantMcpUrl).
 */
import { useCallback, useEffect, useState } from 'react'
import { assistantClientInfo, listAssistantConsents, revokeAssistantConsent, type AssistantConsent } from '../hooks/useAuth'
import styles from './ProfilePanel.module.css'
import own from './AssistantSection.module.css'

interface Row extends AssistantConsent { name: string }

export default function AssistantSection({ mcpUrl }: { mcpUrl: string }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    try {
      const consents = await listAssistantConsents()
      const named = await Promise.all(consents.map(async c => ({ ...c, name: (await assistantClientInfo(c.clientId).catch(() => null))?.name ?? 'Unnamed assistant' })))
      setRows(named)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load connected assistants')
      setRows([])
    }
  }, [])
  useEffect(() => { void load() }, [load])

  async function disconnect(id: string) {
    setError('')
    try { await revokeAssistantConsent(id); await load() } catch (err) { setError(err instanceof Error ? err.message : 'Could not disconnect') }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(mcpUrl); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* the address stays selectable */ }
  }

  return (
    <div className={styles.section}>
      <p className={styles.label}>AI assistants</p>
      <p className={own.text}>
        Ask your own AI assistant about your routes, aerodromes, weather and NOTAMs. Add this address as a custom
        connector (MCP server) in the assistant, then sign in and approve:
      </p>
      <div className={own.urlRow}>
        <code className={own.url}>{mcpUrl}</code>
        <button type="button" className={styles.btnAdd} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <details className={own.help}>
        <summary>Where to add it</summary>
        <ul>
          <li><strong>Claude</strong> (web or desktop): Customize → Connectors → Add custom connector. It then works in the mobile app too.</li>
          <li><strong>ChatGPT</strong> (Plus, Pro, Business): Plugins or Settings → Connectors → add a custom MCP server.</li>
          <li><strong>Gemini</strong> (where available): Settings → Connected apps → Add a custom app.</li>
          <li>Other assistants and coding tools: add a remote MCP server with this address.</li>
        </ul>
        <p className={own.text}>The assistant can only read. Its answers are a planning aid, not an official briefing.</p>
      </details>
      {error && <p className={styles.errorMsg}>{error}</p>}
      {rows === null ? (
        <p className={styles.statusMsg}>Loading…</p>
      ) : rows.length === 0 ? (
        <p className={styles.emptyMsg}>No assistant connected.</p>
      ) : (
        <ul className={styles.passkeyList}>
          {rows.map(r => (
            <li key={r.id} className={styles.passkeyItem}>
              <div className={styles.passkeyInfo}>
                <span className={styles.passkeyName}>{r.name}</span>
                <span className={styles.passkeyDate}>
                  {r.scopes.includes('routes:read') ? 'Briefings, saved routes and aircraft' : 'Briefings only'}
                  {r.createdAt ? ` · since ${new Date(r.createdAt).toLocaleDateString('sv-SE')}` : ''}
                </span>
              </div>
              <button type="button" className={styles.btnRevoke} onClick={() => void disconnect(r.id)} aria-label={`Disconnect ${r.name}`}>
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
