/**
 * GET /api/charts/document?url=<official document URL>
 *
 * EXPERIMENTAL. Pass-through for official, freely published chart documents
 * (aeronautical information publications) listed in a deployment's charts
 * index (`<cc>-charts.json`, see docs/architecture.md "Charts index").
 *
 * Why it exists: the browser app renders a chart page itself (in-app viewer
 * and georeferenced map overlay), which needs the PDF bytes. Publishers'
 * document hosts generally send no CORS headers, so the browser cannot
 * fetch them directly. Native apps fetch directly and don't use this.
 *
 * What it is not: a general proxy or a mirror. The document is passed
 * through byte for byte from the publisher, only for hosts the operator has
 * explicitly allowed, and the response is never altered.
 *
 * Security (AGENTS.md "Server API Security Baseline"):
 *   - auth: session required (401) -- it spends this server's bandwidth
 *   - per-user rate limit: hourly + daily sliding window (429)
 *   - input caps: https only, host must be in CHART_DOCUMENT_HOSTS (exact
 *     match), no credentials/ports, path must end in .pdf; at most one
 *     redirect, and only to another allowed host; response size capped
 *     before and while reading; body must start with %PDF-
 *   - nothing from the client is forwarded upstream (no cookies, no IP)
 *   - errors: detail logged server-side, generic message to the client
 *   - served with `Content-Security-Policy: sandbox` and nosniff so a
 *     document opened directly can't run anything in this origin
 *
 * Disabled (404) unless CHART_DOCUMENT_HOSTS is set.
 *
 * Env:
 *   CHART_DOCUMENT_HOSTS         comma-separated hostnames, e.g. "aip.example.org"
 *   CHART_DOCUMENT_MAX_MB        per-document cap (default 20)
 *   CHART_DOCUMENT_HOURLY_LIMIT  per user (default 120)
 *   CHART_DOCUMENT_DAILY_LIMIT   per user (default 600)
 *   CHART_DOCUMENT_CACHE_MB      shared in-memory cache, 0 = off (default 100)
 */

import { Hono, type Context } from 'hono'

export interface ChartDocumentConfig {
  hosts: Set<string>
  maxBytes: number
  hourlyLimit: number
  dailyLimit: number
  cacheBytes: number
  cacheTtlMs: number
  timeoutMs: number
}

export function chartDocumentConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ChartDocumentConfig {
  const num = (k: string, d: number) => {
    const v = Number(env[k])
    return Number.isFinite(v) && v >= 0 ? v : d
  }
  return {
    hosts: new Set((env['CHART_DOCUMENT_HOSTS'] ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean)),
    maxBytes: num('CHART_DOCUMENT_MAX_MB', 20) * 1024 * 1024,
    hourlyLimit: num('CHART_DOCUMENT_HOURLY_LIMIT', 120),
    dailyLimit: num('CHART_DOCUMENT_DAILY_LIMIT', 600),
    cacheBytes: num('CHART_DOCUMENT_CACHE_MB', 100) * 1024 * 1024,
    cacheTtlMs: 6 * 60 * 60 * 1000,
    timeoutMs: 30_000,
  }
}

/** The document URL if acceptable, else a reason. Pure; exported for tests. */
export function checkDocumentUrl(raw: string | undefined, hosts: ReadonlySet<string>): { url: URL } | { error: string } {
  if (!raw || raw.length > 2048) return { error: 'missing or too long' }
  let url: URL
  try { url = new URL(raw) } catch { return { error: 'not a URL' } }
  if (url.protocol !== 'https:') return { error: 'https only' }
  if (url.username || url.password) return { error: 'credentials not allowed' }
  if (url.port && url.port !== '443') return { error: 'port not allowed' }
  if (!hosts.has(url.hostname.toLowerCase())) return { error: 'host not allowed' }
  if (!/\.pdf$/i.test(decodeURIComponent(url.pathname))) return { error: 'not a PDF path' }
  url.hash = ''
  return { url }
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** Per-user sliding-window limiter (same pattern as the POH extraction limit). */
export function createRateLimiter(hourly: number, daily: number, now: () => number = Date.now) {
  const usage = new Map<string, number[]>()
  return (userId: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } => {
    const t = now()
    const stamps = (usage.get(userId) ?? []).filter(s => t - s < DAY_MS)
    const lastHour = stamps.filter(s => t - s < HOUR_MS)
    if (lastHour.length >= hourly) {
      return { allowed: false, retryAfterSeconds: Math.ceil((Math.min(...lastHour) + HOUR_MS - t) / 1000) }
    }
    if (stamps.length >= daily) {
      return { allowed: false, retryAfterSeconds: Math.ceil((Math.min(...stamps) + DAY_MS - t) / 1000) }
    }
    stamps.push(t)
    usage.set(userId, stamps)
    return { allowed: true }
  }
}

/** Small LRU byte cache shared by all users (the documents are public). */
export function createByteCache(maxBytes: number, ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<string, { body: Uint8Array; at: number }>()
  let total = 0
  return {
    get(key: string): Uint8Array | null {
      const e = entries.get(key)
      if (!e) return null
      if (now() - e.at > ttlMs) { entries.delete(key); total -= e.body.byteLength; return null }
      entries.delete(key)
      entries.set(key, e) // most recently used last
      return e.body
    },
    set(key: string, body: Uint8Array): void {
      if (maxBytes <= 0 || body.byteLength > maxBytes / 4) return
      const old = entries.get(key)
      if (old) { entries.delete(key); total -= old.body.byteLength }
      entries.set(key, { body, at: now() })
      total += body.byteLength
      for (const [k, e] of entries) {
        if (total <= maxBytes) break
        entries.delete(k)
        total -= e.body.byteLength
      }
    },
    get size() { return total },
  }
}

class UpstreamError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const len = Number(res.headers.get('content-length') ?? 'NaN')
  if (Number.isFinite(len) && len > maxBytes) throw new UpstreamError(`content-length ${len} over cap`, 413)
  if (!res.body) throw new UpstreamError('empty body', 502)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new UpstreamError(`body over cap (${size} bytes read)`, 413)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(new ArrayBuffer(size))
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.byteLength }
  return out
}

/** Fetch with at most one redirect, and only to another allowed URL. */
export async function fetchDocument(url: URL, cfg: ChartDocumentConfig, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  let current = url
  for (let hop = 0; hop < 2; hop++) {
    const res = await fetchImpl(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(cfg.timeoutMs),
      headers: { 'User-Agent': 'OpenVFR chart document pass-through', 'Accept': 'application/pdf' },
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      const next = loc ? checkDocumentUrl(new URL(loc, current).toString(), cfg.hosts) : { error: 'no location' }
      if ('error' in next) throw new UpstreamError(`redirect refused: ${'error' in next ? next.error : ''} (${loc})`, 502)
      current = next.url
      continue
    }
    if (res.status !== 200) throw new UpstreamError(`upstream HTTP ${res.status}`, res.status === 404 ? 404 : 502)
    const body = await readCapped(res, cfg.maxBytes)
    const magic = new TextDecoder().decode(body.subarray(0, 5))
    if (magic !== '%PDF-') throw new UpstreamError('upstream body is not a PDF', 502)
    return body
  }
  throw new UpstreamError('too many redirects', 502)
}

export function chartDocumentRoutes(opts: {
  requireUser: (c: Context) => Promise<{ id: string } | null>
  config?: ChartDocumentConfig
  fetchImpl?: typeof fetch
}): Hono {
  const cfg = opts.config ?? chartDocumentConfigFromEnv()
  const limit = createRateLimiter(cfg.hourlyLimit, cfg.dailyLimit)
  const cache = createByteCache(cfg.cacheBytes, cfg.cacheTtlMs)
  const inflight = new Map<string, Promise<Uint8Array>>()
  const app = new Hono()

  app.get('/document', async (c) => {
    if (cfg.hosts.size === 0) return c.json({ error: 'Not found' }, 404)
    const user = await opts.requireUser(c)
    if (!user) return c.json({ error: 'Authentication required.' }, 401)
    const checked = checkDocumentUrl(c.req.query('url'), cfg.hosts)
    if ('error' in checked) return c.json({ error: 'Document not available.' }, 400)
    const rate = limit(user.id)
    if (!rate.allowed) {
      c.header('Retry-After', String(rate.retryAfterSeconds))
      return c.json({ error: 'Too many document requests. Try again later.', retryAfterSeconds: rate.retryAfterSeconds }, 429)
    }

    const key = checked.url.toString()
    let body = cache.get(key)
    if (!body) {
      try {
        let p = inflight.get(key)
        if (!p) {
          p = fetchDocument(checked.url, cfg, opts.fetchImpl).finally(() => inflight.delete(key))
          inflight.set(key, p)
        }
        body = await p
        cache.set(key, body)
      } catch (err) {
        const status = err instanceof UpstreamError ? err.status : 502
        console.error('[charts/document] fetch failed', { url: key, status, error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined })
        return c.json({ error: status === 404 ? 'Document not found.' : 'Document unavailable.' }, status === 404 ? 404 : status === 413 ? 413 : 502)
      }
    }

    const name = (decodeURIComponent(checked.url.pathname.split('/').pop() ?? 'document.pdf')
      .replace(/[^\w.\- ]+/g, '_').slice(0, 120)) || 'document.pdf'
    return new Response(body as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(body.byteLength),
        'Content-Disposition': `inline; filename="${name}"`,
        'Cache-Control': 'private, max-age=21600',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    })
  })

  return app
}
