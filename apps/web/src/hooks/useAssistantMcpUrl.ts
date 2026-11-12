import { useEffect, useState } from 'react'
import { API_BASE_URL } from '../utils/env'

export interface AccountFlags {
  /** False for the shared test account (the server refuses passkeys for it); true when unknown. */
  passkeyAllowed: boolean
  /** The assistant connector address, when the server offers it to this account (feature on, and the assistant UI open to this account). */
  assistantMcpUrl: string | null
}

const UNKNOWN: AccountFlags = { passkeyAllowed: true, assistantMcpUrl: null }
let cached: Promise<AccountFlags> | null = null

/** The account's capability flags (one request per page load, shared by every component that asks). */
export function useAccountFlags(signedIn: boolean): AccountFlags {
  const [flags, setFlags] = useState<AccountFlags>(UNKNOWN)
  useEffect(() => {
    if (!signedIn) { cached = null; setFlags(UNKNOWN); return }
    let live = true
    cached ??= fetch(`${API_BASE_URL}/api/auth/account-flags`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() as Promise<{ passkeyAllowed?: boolean; assistantMcpUrl?: string | null }> : null))
      .then((j): AccountFlags => ({
        passkeyAllowed: j?.passkeyAllowed !== false,
        assistantMcpUrl: typeof j?.assistantMcpUrl === 'string' && j.assistantMcpUrl ? j.assistantMcpUrl : null,
      }))
      .catch(() => UNKNOWN)
    void cached.then(f => { if (live) setFlags(f) })
    return () => { live = false }
  }, [signedIn])
  return flags
}

/** The assistant connector address for the signed-in account, or null (the server decides). */
export function useAssistantMcpUrl(signedIn: boolean): string | null {
  return useAccountFlags(signedIn).assistantMcpUrl
}
