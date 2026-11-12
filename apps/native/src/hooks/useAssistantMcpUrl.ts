import { useEffect, useState } from 'react'
import { API_BASE } from '../config'
import { authHeaders } from '../utils/authClient'

export interface AccountFlags {
  /** The assistant connector address, or null when the server does not offer it to this account (feature off, or limited to admins). */
  assistantMcpUrl: string | null
}

const UNKNOWN: AccountFlags = { assistantMcpUrl: null }

/** The account's capability flags, asked once per sign-in; offline keeps everything hidden. */
export function useAccountFlags(signedIn: boolean): AccountFlags {
  const [flags, setFlags] = useState<AccountFlags>(UNKNOWN)
  useEffect(() => {
    if (!signedIn) { setFlags(UNKNOWN); return }
    let live = true
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/auth/account-flags`, { headers: await authHeaders() })
        if (!res.ok) return
        const j = await res.json() as { assistantMcpUrl?: string | null }
        if (live) setFlags({
          assistantMcpUrl: typeof j.assistantMcpUrl === 'string' && j.assistantMcpUrl ? j.assistantMcpUrl : null,
        })
      } catch { /* offline: stays hidden */ }
    })()
    return () => { live = false }
  }, [signedIn])
  return flags
}

/**
 * The assistant connector address for the signed-in account, or null when the
 * server does not offer it to them (feature off, or limited to admins while it
 * is verified).
 */
export function useAssistantMcpUrl(signedIn: boolean): string | null {
  return useAccountFlags(signedIn).assistantMcpUrl
}
