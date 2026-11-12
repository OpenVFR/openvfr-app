import { useEffect, useState } from 'react'
import { API_BASE_URL } from '../utils/env'

let cached: Promise<string | null> | null = null

/**
 * The assistant connector address for the signed-in account, or null when the
 * server does not offer it to them (the server decides: feature off, or the
 * assistant UI limited to admins while it is verified). One request per page load.
 */
export function useAssistantMcpUrl(signedIn: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!signedIn) { cached = null; setUrl(null); return }
    let live = true
    cached ??= fetch(`${API_BASE_URL}/api/auth/account-flags`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() as Promise<{ assistantMcpUrl?: string | null }> : null))
      .then(j => (typeof j?.assistantMcpUrl === 'string' && j.assistantMcpUrl ? j.assistantMcpUrl : null))
      .catch(() => null)
    // A failed request is not kept for the whole page load: the next mount asks again.
    const asked = cached
    void asked.then(u => { if (u === null && cached === asked) cached = null })
    void cached.then(u => { if (live) setUrl(u) })
    return () => { live = false }
  }, [signedIn])
  return url
}
