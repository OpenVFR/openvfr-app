/** The assistants (OAuth clients) this account has approved: list them and disconnect them. Same calls as the web app. */
import { authClient } from './authClient'

export interface AssistantConsent {
  id: string
  clientId: string
  scopes: string[]
  createdAt: string | null
  /** The assistant's own name, from its public client record. */
  name: string
}

export async function listAssistantConsents(): Promise<AssistantConsent[]> {
  const res = await authClient.$fetch<unknown[]>('/oauth2/get-consents', { method: 'GET' })
  if (res.error) throw new Error(res.error.message || 'Could not load connected assistants')
  const rows = (res.data ?? []).map((c) => {
    const o = c as Record<string, unknown>
    const scopes = Array.isArray(o['scopes']) ? (o['scopes'] as string[]) : typeof o['scopes'] === 'string' ? (o['scopes'] as string).split(' ') : []
    return { id: String(o['id'] ?? ''), clientId: String(o['clientId'] ?? o['client_id'] ?? ''), scopes, createdAt: typeof o['createdAt'] === 'string' ? o['createdAt'] : null }
  })
  return Promise.all(rows.map(async r => {
    const info = await authClient.$fetch<Record<string, unknown>>('/oauth2/public-client', { method: 'GET', query: { client_id: r.clientId } }).catch(() => null)
    const name = info?.data && typeof info.data['client_name'] === 'string' && info.data['client_name'] ? info.data['client_name'] : 'Unnamed assistant'
    return { ...r, name }
  }))
}

export async function revokeAssistantConsent(id: string): Promise<void> {
  const res = await authClient.$fetch('/oauth2/delete-consent', { method: 'POST', body: { id } })
  if (res.error) throw new Error(res.error.message || 'Could not disconnect')
}
