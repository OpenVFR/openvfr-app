/**
 * openMeteo — the single way the apps call the Open-Meteo forecast API
 * (`/api/open-meteo/...`, proxied to api.open-meteo.com).
 *
 * Open-Meteo's free tier is rate limited per IP (600 calls/min, 5 000/h,
 * 10 000/day) and answers 429 or 503 when it is overloaded or a limit is hit.
 * The API server relays it (session required, per-user caps, its own cache
 * and upstream budget) and answers 429/503 + Retry-After the same way.
 * Behind the production proxy every user shares the server's IP, so a client
 * that answers a 503 with quick retries (as the generic fetchWithRetry does)
 * makes the overload worse: every failure turned into three requests, from
 * every open map at once. This module instead:
 *
 *  - shares one request between callers asking for the same URL at the same
 *    time (it is only aborted once every caller has aborted);
 *  - runs at most MAX_CONCURRENT requests at a time;
 *  - on 429/503 closes a gate for ALL Open-Meteo requests: `Retry-After`
 *    when sent, else an exponential backoff with jitter (5 s, 15 s, 45 s, …
 *    up to 5 min); an explicit hourly/daily limit closes it until the next
 *    hour/day;
 *  - retries a throttled request once, after the gate reopens, and only
 *    while someone still wants it; a request that would have to wait longer
 *    than MAX_WAIT_MS fails at once (callers keep showing what they have).
 *
 * Network errors (offline, Wi-Fi handoff) are not upstream load: they get one
 * quick retry and do not close the gate.
 */

import { apiAuthHeaders } from './apiAuth'

export class OpenMeteoError extends Error {
  constructor(message: string, readonly status: number | null, readonly throttled: boolean) {
    super(message)
    this.name = 'OpenMeteoError'
  }
}

const MAX_CONCURRENT = 2
/** Never park a request longer than this waiting for the gate. */
const MAX_WAIT_MS = 60_000
const BACKOFF_BASE_MS = 5_000
const BACKOFF_FACTOR = 3
const BACKOFF_MAX_MS = 5 * 60_000
const NETWORK_RETRY_MS = 1_500
const THROTTLE_STATUSES = new Set([429, 503])

// ── Gate state (module-level: shared by every caller in the app) ────────────
let closedUntil = 0
/** When the gate last closed: throttled answers to requests sent before it
 *  are the same incident and must not escalate the backoff again. */
let closedAt = -Infinity
let consecutiveThrottles = 0
let failureCount = 0
let active = 0
const waiting: (() => void)[] = []
const inflight = new Map<string, { promise: Promise<unknown>; users: number; ac: AbortController }>()

/** Test hook / clock seam. */
let now = () => Date.now()
let random = () => Math.random()

/** ms until Open-Meteo requests may go out again (0 = open). */
export function openMeteoCooldownMs(): number {
  return Math.max(0, closedUntil - now())
}

/** Increments on every failed Open-Meteo request; lets a caller tell that a
 *  fetch it just ran came back incomplete and is worth trying again later. */
export function openMeteoFailureCount(): number {
  return failureCount
}

/** Resolves once the gate is open (rejects with AbortError on abort). */
export function whenOpenMeteoOpen(signal?: AbortSignal): Promise<void> {
  return sleep(openMeteoCooldownMs(), signal)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return }
    if (ms <= 0) { resolve(); return }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); reject(abortError()) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(): Error {
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

/**
 * How long to close the gate after a throttled response. Exported for tests.
 * `retryAfter` is the raw header; `reason` Open-Meteo's JSON error reason.
 */
export function throttleDelayMs(attempt: number, retryAfter: string | null, reason: string, at: number, rnd: number): number {
  if (/daily/i.test(reason)) {
    const d = new Date(at)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - at + 60_000
  }
  if (/hourly/i.test(reason)) return 3_600_000 - (at % 3_600_000) + 30_000
  if (/minutely/i.test(reason)) return 60_000 - (at % 60_000) + 5_000
  if (retryAfter) {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs) && secs >= 0) return Math.min(BACKOFF_MAX_MS, secs * 1000)
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return Math.min(BACKOFF_MAX_MS, Math.max(0, date - at))
  }
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * BACKOFF_FACTOR ** attempt)
  // Full jitter on the upper half: spreads clients that failed together.
  return Math.round(base / 2 + rnd * (base / 2))
}

async function acquireSlot(signal: AbortSignal): Promise<void> {
  while (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve, reject) => {
      const go = () => { signal.removeEventListener('abort', onAbort); resolve() }
      const onAbort = () => { const i = waiting.indexOf(go); if (i >= 0) waiting.splice(i, 1); reject(abortError()) }
      waiting.push(go)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  active++
}

function releaseSlot(): void {
  active--
  waiting.shift()?.()
}

async function waitForGate(signal: AbortSignal): Promise<void> {
  // Loop: another throttled answer may push the gate further out while we sleep.
  for (let wait = openMeteoCooldownMs(); wait > 0; wait = openMeteoCooldownMs()) {
    if (wait > MAX_WAIT_MS) {
      throw new OpenMeteoError(`Open-Meteo throttled, retry in ${Math.round(wait / 1000)} s`, null, true)
    }
    await sleep(wait, signal)
  }
  if (signal.aborted) throw abortError()
}

async function attempt(url: string, signal: AbortSignal): Promise<unknown> {
  await waitForGate(signal)
  await acquireSlot(signal)
  let res: Response
  let reason = ''
  try {
    // Re-check: the gate may have closed while this request sat in the queue.
    await waitForGate(signal)
    const sentAt = now()
    // Session required by the API server's proxy (apps/api externalProxy.ts).
    res = await fetch(url, { signal, credentials: 'include', headers: await apiAuthHeaders() })
    if (!res.ok) {
      // Read the reason and close the gate BEFORE releasing the slot, or the
      // queued requests go out in the meantime.
      try { reason = String(((await res.json()) as { reason?: unknown })?.reason ?? '') } catch { /* not JSON */ }
      if (THROTTLE_STATUSES.has(res.status)) {
        // <=: a request can't go out once the gate is closed, so one sent in
        // the same millisecond was already in flight.
        const sameIncident = sentAt <= closedAt
        const delay = throttleDelayMs(sameIncident ? Math.max(0, consecutiveThrottles - 1) : consecutiveThrottles,
          res.headers.get('Retry-After'), reason, now(), random())
        if (!sameIncident) consecutiveThrottles++
        if (now() + delay > closedUntil) {
          closedUntil = now() + delay
          closedAt = now()
        }
      }
    }
  } finally {
    releaseSlot()
  }
  if (res.ok) {
    consecutiveThrottles = 0
    return res.json()
  }
  const msg = `Open-Meteo HTTP ${res.status}${reason ? `: ${reason}` : ''}`
  throw new OpenMeteoError(msg, res.status, THROTTLE_STATUSES.has(res.status))
}

async function run(url: string, signal: AbortSignal): Promise<unknown> {
  try {
    return await attempt(url, signal)
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    const network = !(err instanceof OpenMeteoError)
    // Retry once: throttled responses after the gate reopens (attempt() waits
    // for it), network errors after a short pause. Not retried: other HTTP
    // errors, and a gate closed for longer than MAX_WAIT_MS (status null).
    const retryable = network || (err.throttled && err.status !== null)
    if (!retryable) { failureCount++; throw err }
    try {
      if (network) await sleep(NETWORK_RETRY_MS, signal)
      return await attempt(url, signal)
    } catch (err2) {
      if ((err2 as Error).name !== 'AbortError') failureCount++
      throw err2
    }
  }
}

/**
 * GET an Open-Meteo URL and return its parsed JSON. Throws OpenMeteoError on
 * an HTTP error or a closed gate, the fetch error on a network failure, and
 * AbortError when `signal` aborts.
 */
export function openMeteoJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let entry = inflight.get(url)
  if (!entry) {
    const ac = new AbortController()
    const promise = run(url, ac.signal).finally(() => {
      if (inflight.get(url)?.promise === promise) inflight.delete(url)
    })
    // Unobserved rejection guard: callers attach their own handlers below.
    promise.catch(() => {})
    entry = { promise, users: 0, ac }
    inflight.set(url, entry)
  }
  const e = entry
  e.users++
  return new Promise<T>((resolve, reject) => {
    let done = false
    const leave = () => {
      if (done) return
      done = true
      signal?.removeEventListener('abort', onAbort)
      if (--e.users === 0 && inflight.get(url) === e) {
        // Nobody wants this any more: stop it (frees its queue slot).
        e.ac.abort()
        inflight.delete(url)
      }
    }
    const onAbort = () => { leave(); reject(abortError()) }
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })
    e.promise.then(
      (v) => { if (!done) { done = true; e.users--; signal?.removeEventListener('abort', onAbort); resolve(v as T) } },
      (err) => { if (!done) { done = true; e.users--; signal?.removeEventListener('abort', onAbort); reject(err) } },
    )
  })
}

/** Shortest / longest life of a cached Open-Meteo "current" reading. The
 *  minimum also stops a refetch loop when a proxy-cached response still
 *  carries the previous slot (the proxy keeps responses 5 min). */
const CURRENT_MIN_TTL_MS = 5 * 60_000
const CURRENT_MAX_TTL_MS = 30 * 60_000
/** Open-Meteo publishes a slot's value shortly after it starts. */
const CURRENT_PUBLISH_MARGIN_MS = 60_000

/**
 * When a cached "current" reading should be refetched: as soon as Open-Meteo's
 * next value is due (`time` + `interval` of the response's `current` block,
 * normally 15 min), not a fixed time after we happened to receive it -- a
 * response can already be minutes old when it arrives through the proxy
 * cache. Clamped to [now + 5 min, now + 30 min]; 30 min when the block
 * carries no slot time.
 */
export function currentExpiresAt(current: { time?: number; interval?: number } | undefined, at: number): number {
  const t = current?.time, iv = current?.interval
  if (typeof t !== 'number' || typeof iv !== 'number' || iv <= 0) return at + CURRENT_MAX_TTL_MS
  const due = (t + iv) * 1000 + CURRENT_PUBLISH_MARGIN_MS
  return Math.min(at + CURRENT_MAX_TTL_MS, Math.max(at + CURRENT_MIN_TTL_MS, due))
}

/** Snap a coordinate to a 0.05° lattice (~3-5 km): within the forecast
 *  models' own resolution, and it makes nearby requests -- from the route,
 *  the map grid, the aircraft position, other users -- share one URL, so
 *  caches (in-app and at the proxy) actually hit. */
export function snapCoord(deg: number): number {
  return Math.round(deg * 20) / 20
}

/** Test-only: reset gate state and swap the clock / RNG. */
export function __resetOpenMeteoForTests(opts: { now?: () => number; random?: () => number } = {}): void {
  closedUntil = 0
  closedAt = -Infinity
  consecutiveThrottles = 0
  failureCount = 0
  active = 0
  waiting.length = 0
  inflight.clear()
  now = opts.now ?? (() => Date.now())
  random = opts.random ?? (() => Math.random())
}
