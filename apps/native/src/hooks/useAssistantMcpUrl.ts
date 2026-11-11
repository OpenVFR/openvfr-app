import { useEffect, useState } from 'react'
import { API_BASE } from '../config'
import { authHeaders } from '../utils/authClient'

/**
 * The assistant connector address for the signed-in account, or null when the
 * server does not offer it to them (feature off, or limited to admins while it
 * is verified). Asked once per sign-in; offline keeps it hidden.
 */
export function useAssistantMcpUrl(signedIn: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!signedIn) { setUrl(null); return }
    let live = true
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/auth/account-flags`, { headers: await authHeaders() })
        if (!res.ok) return
        const j = await res.json() as { assistantMcpUrl?: string | null }
        if (live && typeof j.assistantMcpUrl === 'string' && j.assistantMcpUrl) setUrl(j.assistantMcpUrl)
      } catch { /* offline: stays hidden */ }
    })()
    return () => { live = false }
  }, [signedIn])
  return url
}
