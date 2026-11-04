/**
 * Guards of POST /api/poh-extract. Every extraction sends a whole PDF to a paid model in ONE request, so cost is bounded
 * here and not only by the model deployment's capacity:
 *
 *   per user     POH_DAILY_LIMIT (5) and POH_HOURLY_LIMIT (3) extractions
 *   all users    POH_GLOBAL_DAILY_LIMIT (50) extractions a day: sign-up is open (an email code), so per-user limits alone
 *                do not bound the total
 *   at once      POH_MAX_CONCURRENT (2) extractions running
 *   per request  POH_MAX_PAGES (250) pages, POH_MAX_OUTPUT_TOKENS (16000) answer tokens
 *
 * All in memory, like the other limiters: one api instance, reset by a restart. A refused request is never charged.
 */

import { inflateSync } from 'node:zlib'
import { RateLimiter, limitFromEnv } from './rateLimiter.js'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export interface PohGuardConfig {
  hourlyPerUser: number
  dailyPerUser: number
  dailyGlobal: number
  maxConcurrent: number
  maxPages: number
  maxOutputTokens: number
}

export function pohGuardConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PohGuardConfig {
  return {
    hourlyPerUser: limitFromEnv('POH_HOURLY_LIMIT', 3, env),
    dailyPerUser: limitFromEnv('POH_DAILY_LIMIT', 5, env),
    dailyGlobal: limitFromEnv('POH_GLOBAL_DAILY_LIMIT', 50, env),
    maxConcurrent: limitFromEnv('POH_MAX_CONCURRENT', 2, env),
    maxPages: limitFromEnv('POH_MAX_PAGES', 250, env),
    maxOutputTokens: limitFromEnv('POH_MAX_OUTPUT_TOKENS', 16000, env),
  }
}

export type GuardResult =
  | { allowed: true }
  | { allowed: false; status: 429 | 503; retryAfterSeconds: number; reason: string }

const GLOBAL_KEY = 'all'

export class PohGuards {
  private readonly perUser: RateLimiter
  private readonly global: RateLimiter
  private running = 0

  constructor(readonly config: PohGuardConfig) {
    this.perUser = new RateLimiter([
      { windowMs: HOUR_MS, max: config.hourlyPerUser },
      { windowMs: DAY_MS, max: config.dailyPerUser },
    ])
    this.global = new RateLimiter([{ windowMs: DAY_MS, max: config.dailyGlobal }])
  }

  private refusal(userId: string, now: number): GuardResult {
    const u = this.perUser.check(userId, now)
    if (u.waitS > 0) {
      const reason = u.limit?.windowMs === HOUR_MS
        ? `Hourly limit of ${this.config.hourlyPerUser} POH extractions reached.`
        : `Daily limit of ${this.config.dailyPerUser} POH extractions reached.`
      return { allowed: false, status: 429, retryAfterSeconds: u.waitS, reason }
    }
    const g = this.global.check(GLOBAL_KEY, now)
    if (g.waitS > 0) {
      return { allowed: false, status: 429, retryAfterSeconds: g.waitS, reason: 'POH extraction has reached its daily capacity for all users.' }
    }
    return { allowed: true }
  }

  /** Cheap early check before the upload is read: the user's limits and the global one. Charges nothing. */
  precheck(userId: string, now = Date.now()): GuardResult {
    const r = this.refusal(userId, now)
    if (!r.allowed) return r
    if (this.running >= this.config.maxConcurrent) {
      return { allowed: false, status: 503, retryAfterSeconds: 30, reason: 'POH extraction is busy right now.' }
    }
    return { allowed: true }
  }

  /**
   * A place among the running extractions, or a refusal. Take it BEFORE charging, and call the returned function when
   * the extraction ends (any outcome); calling it twice is harmless.
   */
  tryAcquire(): { allowed: true; release: () => void } | Extract<GuardResult, { allowed: false }> {
    if (this.running >= this.config.maxConcurrent) {
      return { allowed: false, status: 503, retryAfterSeconds: 30, reason: 'POH extraction is busy right now.' }
    }
    this.running++
    let released = false
    return { allowed: true, release: () => { if (!released) { released = true; this.running-- } } }
  }

  /** Charge one extraction to the user and to the global count, atomically: nothing is charged when either refuses. */
  charge(userId: string, now = Date.now()): GuardResult {
    const r = this.refusal(userId, now)
    if (!r.allowed) return r
    this.perUser.record(userId, now)
    this.global.record(GLOBAL_KEY, now)
    return { allowed: true }
  }

  get inFlight(): number {
    return this.running
  }
}

// ── page count ──────────────────────────────────────────────────────────────

const MAX_DECODED_BYTES = 64 * 1024 * 1024

/**
 * Number of pages of a PDF, read without a PDF library: the page objects (`/Type /Page`) and the `/Count` of the page
 * tree (`/Type /Pages`), also inside compressed object streams, where most PDFs from Word and Acrobat keep them. The larger
 * of the two counts wins (a count that is too high only refuses sooner). Null when neither can be found (an unusual
 * encoding): the caller then relies on the size cap.
 */
export function countPdfPages(bytes: Uint8Array): number | null {
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
  const parts: string[] = [raw]
  let decoded = 0
  const stream = /\/ObjStm[\s\S]{0,400}?stream\r?\n/g
  for (let m = stream.exec(raw); m !== null && decoded < MAX_DECODED_BYTES; m = stream.exec(raw)) {
    const start = m.index + m[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) continue
    try {
      const out = inflateSync(bytes.subarray(start, end), { finishFlush: 2 /* Z_SYNC_FLUSH: tolerate a cut tail */ })
      decoded += out.length
      parts.push(out.toString('latin1'))
    } catch { /* not zlib data, or damaged: ignore this stream */ }
  }
  const text = parts.join('\n')
  const pageObjects = (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length
  let treeCount = 0
  for (const d of text.matchAll(/<<[^<>]*?\/Type\s*\/Pages(?![A-Za-z])[^<>]*?>>/g)) {
    const c = /\/Count\s+(\d+)/.exec(d[0])
    if (c) treeCount = Math.max(treeCount, Number(c[1]))
  }
  const pages = Math.max(pageObjects, treeCount)
  return pages > 0 ? pages : null
}
