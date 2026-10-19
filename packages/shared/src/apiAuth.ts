/**
 * apiAuth — how shared fetch code authenticates to the OpenVFR API server.
 *
 * Web: the session cookie, sent by `credentials: 'include'` (split-origin
 * production: app and API on different subdomains). Native: React Native
 * has no cookie jar, so the app registers a provider of its
 * `Authorization: Bearer` header once at startup (setApiAuthHeaders).
 * Used by shared code that has no per-call `headers` parameter of its own
 * (the Open-Meteo gate, the terrain profile fetch).
 */

type HeaderProvider = () => Record<string, string> | Promise<Record<string, string>>

let provider: HeaderProvider | null = null

export function setApiAuthHeaders(fn: HeaderProvider | null): void {
  provider = fn
}

/** Extra headers for an API request; {} when none (web) or on error. */
export async function apiAuthHeaders(): Promise<Record<string, string>> {
  if (!provider) return {}
  try { return await provider() } catch { return {} }
}
