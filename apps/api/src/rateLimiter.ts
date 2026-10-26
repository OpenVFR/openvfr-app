/**
 * In-memory sliding-window rate limiter keyed by user id, IP or email.
 *
 * One limiter holds several windows (e.g. hourly + daily) over the same
 * timestamps. Keys with no hit left inside the longest window are dropped
 * every SWEEP_EVERY records, so one-off callers (an IP that sent a single
 * sign-in code) don't stay in memory forever.
 *
 * Per-process, like the other limiters here: fine for one api instance;
 * move to a shared store (Redis, DB) if the api ever scales out.
 */

export interface WindowLimit {
  windowMs: number
  max: number
}

export interface LimitResult {
  /** Seconds until the key may act again; 0 = allowed now. */
  waitS: number
  /** The limit that blocked, when waitS > 0. */
  limit?: WindowLimit
}

const SWEEP_EVERY = 1000

export class RateLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly horizonMs: number
  private records = 0

  constructor(private readonly limits: readonly WindowLimit[]) {
    if (limits.length === 0) throw new Error('RateLimiter needs at least one limit')
    this.horizonMs = Math.max(...limits.map((l) => l.windowMs))
  }

  /** Timestamps of `key` inside the longest window, oldest first. */
  private recent(key: string, now: number): number[] {
    const ts = this.hits.get(key)
    if (!ts) return []
    let i = 0
    while (i < ts.length && now - ts[i]! >= this.horizonMs) i++
    if (i === ts.length) { this.hits.delete(key); return [] }
    if (i > 0) { const kept = ts.slice(i); this.hits.set(key, kept); return kept }
    return ts
  }

  /** Whether `key` may act now (`weight` times), without recording anything. */
  check(key: string, now = Date.now(), weight = 1): LimitResult {
    const ts = this.recent(key, now)
    let worst: LimitResult = { waitS: 0 }
    for (const limit of this.limits) {
      if (weight > limit.max) return { waitS: Math.ceil(limit.windowMs / 1000), limit }
      const inWin = ts.filter((t) => now - t < limit.windowMs)
      if (inWin.length + weight <= limit.max) continue
      // The entry whose expiry frees enough room for `weight` more.
      const freeing = inWin[inWin.length + weight - limit.max - 1]!
      const waitS = Math.max(1, Math.ceil((freeing + limit.windowMs - now) / 1000))
      if (waitS > worst.waitS) worst = { waitS, limit }
    }
    return worst
  }

  /** Record `weight` hits for `key`. */
  record(key: string, now = Date.now(), weight = 1): void {
    const ts = this.recent(key, now)
    for (let i = 0; i < weight; i++) ts.push(now)
    this.hits.set(key, ts)
    if (++this.records % SWEEP_EVERY === 0) this.sweep(now)
  }

  /** check() and, when allowed, record(). */
  take(key: string, now = Date.now(), weight = 1): LimitResult {
    const r = this.check(key, now, weight)
    if (r.waitS === 0) this.record(key, now, weight)
    return r
  }

  /** Drop every key with no hit inside the longest window. */
  sweep(now = Date.now()): void {
    for (const key of [...this.hits.keys()]) this.recent(key, now)
  }

  /** Number of keys held (tests, diagnostics). */
  get size(): number {
    return this.hits.size
  }
}

/**
 * A positive integer limit from the environment. Unset, empty (docker
 * compose passes unset `${VAR:-}` as '') or invalid falls back to `fallback`
 * -- never to 0, which would refuse every request.
 */
export function limitFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (Number.isInteger(n) && n > 0) return n
  console.warn(`[config] ${name}=${JSON.stringify(raw)} is not a positive integer; using ${fallback}`)
  return fallback
}
