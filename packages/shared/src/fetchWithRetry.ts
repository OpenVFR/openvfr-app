/**
 * fetchWithRetry — small retry-with-backoff wrapper around `fetch`, shared
 * between web and native.
 *
 * Purpose: tolerate BRIEF connectivity gaps (a momentary Wi-Fi/LTE handoff,
 * a dropped packet, a transient 502/503/504 from a proxy mid-restart) —
 * distinct from full offline-mode handling (see docs/todo.md's staleness/
 * cache-based degradation for that). Before this existed, every one-shot
 * fetch in the app (weather, NOTAM, wind, terrain profile) would surface a
 * user-visible error from a single dropped packet, forcing a manual retry
 * (re-open the popup / re-fetch) even though the network was fine a second
 * later. This wrapper is a drop-in replacement for `fetch()` — callers keep
 * all their existing response-status handling unchanged (e.g. a caller that
 * special-cases HTTP 503 as "feature not available" still sees that same
 * status code, just only after retries are exhausted, so a single transient
 * 503 no longer masquerades as a persistent one).
 *
 * Does NOT retry:
 *   - An aborted request (AbortError) — always rethrown immediately, never
 *     retried. Retrying past an intentional cancellation (component
 *     unmount, user closed the popup) would be wasted work and could race
 *     a newer request for the same data.
 *   - Any HTTP status not in `retryStatuses` (default: 429, 502, 503, 504).
 *     A 400/401/404/etc. is a client-side or permanent-state problem —
 *     retrying it with the same request will not help and only delays the
 *     caller from surfacing the real error.
 *
 * Backoff: exponential, `baseDelayMs * 2^attempt`, capped at `maxDelayMs`.
 * Default 2 retries (3 attempts total) with 400ms base / 3s cap keeps the
 * worst case under ~4 seconds — short enough that a popup's loading spinner
 * doesn't feel broken, long enough to ride out a real brief gap.
 *
 * Defaults `credentials: 'include'` unless the caller explicitly overrides
 * it. Required for the web app's split-origin production deployment
 * (app.openvfr.org calling api.openvfr.org) -- without it, a cross-origin
 * `fetch()` does NOT send the session cookie by default even though nginx's
 * CORS config already allows credentialed requests for this exact origin
 * (Access-Control-Allow-Credentials: true), causing every session-gated
 * endpoint (weather, NOTAM) to 401 despite the user being logged in. Native
 * callers pass an explicit Authorization header instead of relying on
 * cookies (see @open-vfr/shared's authHeaders() usage) and are unaffected
 * either way -- React Native's fetch has no browser-style cookie jar for
 * this option to change the behavior of.
 */

export interface RetryOptions {
  /** Number of retries AFTER the first attempt. Default 2 (3 attempts total). */
  retries?:       number
  /** Base delay before the first retry, doubled each subsequent attempt. Default 400ms. */
  baseDelayMs?:   number
  /** Upper bound on any single backoff delay. Default 3000ms. */
  maxDelayMs?:    number
  /** HTTP status codes worth retrying (transient/server-side). Default [429, 502, 503, 504]. */
  retryStatuses?: number[]
}

function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError'
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: RetryOptions,
): Promise<Response> {
  const retries       = opts?.retries ?? 2
  const baseDelayMs   = opts?.baseDelayMs ?? 400
  const maxDelayMs    = opts?.maxDelayMs ?? 3000
  const retryStatuses = opts?.retryStatuses ?? [429, 502, 503, 504]

  let lastResponse: Response | undefined
  let lastError: unknown

  const initWithCredentials: RequestInit = { credentials: 'include', ...init }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(input, initWithCredentials)
      if (resp.ok || !retryStatuses.includes(resp.status) || attempt === retries) {
        return resp
      }
      lastResponse = resp
    } catch (err) {
      if (isAbortError(err)) throw err
      lastError = err
      if (attempt === retries) throw err
    }
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
    await sleep(delay, init?.signal)
  }

  // Unreachable (the loop above always returns or throws on its last
  // iteration) -- satisfies the compiler's control-flow analysis.
  if (lastResponse) return lastResponse
  throw lastError
}
