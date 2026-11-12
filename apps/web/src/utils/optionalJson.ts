import { fetchWithRetry } from '@open-vfr/shared/fetchWithRetry'

/**
 * A per-session cache for optional JSON files (the charts index, the aerodrome details). A missing file (4xx: not published for
 * this deployment) is remembered as null. A network error, a server error or an unreadable body is NOT: the caller gets null
 * this time, and the next call tries again, so one dropped request does not hide the data until the page is reloaded.
 */
export function loadOptionalJson<T>(
  cache: Map<string, Promise<T | null>>, url: string, parse: (raw: unknown) => T | null,
): Promise<T | null> {
  const hit = cache.get(url)
  if (hit) return hit
  const p: Promise<T | null> = fetchWithRetry(url, { credentials: 'same-origin' })
    .then(async (r) => {
      if (r.ok) return parse(await r.json())
      if (r.status >= 400 && r.status < 500) return null              // not there: normal, remember it
      throw new Error(`HTTP ${r.status} for ${url}`)
    })
    .catch((err) => {
      if (cache.get(url) === p) cache.delete(url)                       // transient: forget, so the next call retries
      console.warn(`[optionalJson] ${url}:`, err instanceof Error ? err.message : err)
      return null
    })
  cache.set(url, p)
  return p
}
