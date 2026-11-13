/**
 * GET /api/charts/document/:country/:chartId
 *
 * EXPERIMENTAL. Pass-through for official, freely published chart documents
 * (aeronautical information publications) listed in a deployment's charts
 * index (`<cc>-charts.public.json` for released airfields; `<cc>-charts.preview.json` for every airfield, admins only; see
 * docs/architecture.md "Charts index").
 *
 * Why it exists: the browser app renders a chart page itself (in-app viewer
 * and georeferenced map overlay), which needs the PDF bytes. Publishers'
 * document hosts generally send no CORS headers, so the browser cannot
 * fetch them directly. Native apps fetch directly and don't use this.
 *
 * The client names a chart, never a URL: the document URL comes from the
 * same published indexes the app reads (`<TILES_BASE_URL>/<cc>-charts.public.json` and `.preview.json`,
 * located through `manifest.json` by content hash, re-checked every few
 * minutes). So only documents the operator's index lists can be fetched,
 * and serving a stored copy later would need no client change.
 *
 * What it is not: a general proxy or a mirror. The document is passed
 * through byte for byte from the publisher, only for hosts the operator has
 * explicitly allowed, and the response is never altered.
 *
 * Security (AGENTS.md "Server API Security Baseline"):
 *   - auth: session required (401) -- it spends this server's bandwidth
 *   - per-user rate limit: hourly + daily sliding window (429)
 *   - input caps: country and chart id by pattern; the chart must be in the
 *     published index and the index must allow viewing (`display.document`);
 *     its URL must still pass: https only, host in CHART_DOCUMENT_HOSTS (exact
 *     match), no credentials/ports, path must end in .pdf; at most one
 *     redirect, and only to another allowed host; response size capped
 *     before and while reading; body must start with %PDF-
 *   - nothing from the client is forwarded upstream (no cookies, no IP)
 *   - errors: detail logged server-side, generic message to the client
 *   - served with `Content-Security-Policy: sandbox` and nosniff so a
 *     document opened directly can't run anything in this origin
 *
 * Disabled (404) unless CHART_DOCUMENT_HOSTS and TILES_BASE_URL are set.
 *
 * Env:
 *   TILES_BASE_URL               tile host the charts index is published on
 *   CHART_DOCUMENT_HOSTS         comma-separated hostnames, e.g. "aip.example.org"
 *   CHART_DOCUMENT_MAX_MB        per-document cap (default 20)
 *   CHART_DOCUMENT_HOURLY_LIMIT  per user (default 120)
 *   CHART_DOCUMENT_DAILY_LIMIT   per user (default 600)
 *   CHART_DOCUMENT_CACHE_MB      shared in-memory cache, 0 = off (default 100)
 *   CHART_DOCUMENT_ADMIN_ONLY    1/true: only accounts with role 'admin' may fetch documents at all (403 for others). Off by
 *                                default: every signed-in user may fetch the documents of the charts in the PUBLIC index
 *                                (`<cc>-charts.public.json`, released airfields); a chart that is only in the preview index
 *                                (`<cc>-charts.preview.json`, every airfield) is served to role 'admin' only (404 otherwise).
 */

import { Hono, type Context } from 'hono'
import { RateLimiter, limitFromEnv } from './rateLimiter.js'
import { CHART_ID, findChart, parseChartsIndex, type ChartsIndex } from '@open-vfr/shared/chartsIndex'
import { countryDatasetFile } from '@open-vfr/shared/countryData'

export interface ChartDocumentConfig {
  hosts: Set<string>
  /** Tile host the `<cc>-charts.public.json` / `<cc>-charts.preview.json` indexes are published on ('' = disabled). */
  tilesBaseUrl: string
  /** How long a loaded index is trusted before the manifest is checked again. */
  indexTtlMs: number
  maxBytes: number
  hourlyLimit: number
  dailyLimit: number
  cacheBytes: number
  cacheTtlMs: number
  timeoutMs: number
  /** Only role 'admin' may fetch documents. Optional: absent = open to every signed-in user. */
  adminOnly?: boolean
}

export function chartDocumentConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ChartDocumentConfig {
  // An empty or invalid value means the default (Number('') is 0, which would refuse everything). Only the cache size may be 0 (= off).
  const cacheMb = (() => {
    const raw = env['CHART_DOCUMENT_CACHE_MB']?.trim()
    const v = raw ? Number(raw) : NaN
    return Number.isFinite(v) && v >= 0 ? v : 100
  })()
  return {
    hosts: new Set((env['CHART_DOCUMENT_HOSTS'] ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean)),
    tilesBaseUrl: (env['TILES_BASE_URL'] ?? '').trim().replace(/\/+$/, ''),
    indexTtlMs: 10 * 60 * 1000,
    maxBytes: limitFromEnv('CHART_DOCUMENT_MAX_MB', 20, env) * 1024 * 1024,
    hourlyLimit: limitFromEnv('CHART_DOCUMENT_HOURLY_LIMIT', 120, env),
    dailyLimit: limitFromEnv('CHART_DOCUMENT_DAILY_LIMIT', 600, env),
    cacheBytes: cacheMb * 1024 * 1024,
    cacheTtlMs: 6 * 60 * 60 * 1000,
    timeoutMs: 30_000,
    adminOnly: /^(1|true)$/i.test((env['CHART_DOCUMENT_ADMIN_ONLY'] ?? '').trim()),
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
  let path: string
  try { path = decodeURIComponent(url.pathname) } catch { return { error: 'bad path encoding' } }
  if (!/\.pdf$/i.test(path)) return { error: 'not a PDF path' }
  url.hash = ''
  return { url }
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** Per-user hourly + daily limit on the shared RateLimiter (idle users are evicted there). */
export function createRateLimiter(hourly: number, daily: number, now: () => number = Date.now) {
  const rl = new RateLimiter([{ windowMs: HOUR_MS, max: hourly }, { windowMs: DAY_MS, max: daily }])
  return (userId: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } => {
    const t = now()
    const r = rl.check(userId, t)
    if (r.waitS > 0) return { allowed: false, retryAfterSeconds: r.waitS }
    rl.record(userId, t)
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
      await res.body?.cancel().catch(() => undefined)             // an unread body keeps the connection busy
      if ('error' in next) throw new UpstreamError(`redirect refused: ${next.error} (${loc})`, 502)
      current = next.url
      continue
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined)
      throw new UpstreamError(`upstream HTTP ${res.status}`, res.status === 404 ? 404 : 502)
    }
    const body = await readCapped(res, cfg.maxBytes)
    const magic = new TextDecoder().decode(body.subarray(0, 5))
    if (magic !== '%PDF-') throw new UpstreamError('upstream body is not a PDF', 502)
    return body
  }
  throw new UpstreamError('too many redirects', 502)
}

const INDEX_MAX_BYTES = 16 * 1024 * 1024
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024
/** A chart id missing from a fresh-enough index triggers at most one reload per this interval. */
const MISS_RELOAD_MS = 60 * 1000

async function fetchJson(url: string, maxBytes: number, cfg: ChartDocumentConfig, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(cfg.timeoutMs), headers: { Accept: 'application/json' } })
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined)
    throw new UpstreamError(`HTTP ${res.status} for ${url}`, 502)
  }
  return JSON.parse(new TextDecoder().decode(await readCapped(res, maxBytes)))
}

/** Which published index: `public` (released airfields) or `preview` (every airfield, admins only). */
export type ChartIndexKind = 'public' | 'preview'
const INDEX_DATASET = { public: 'charts', preview: 'chartsPreview' } as const
/** The manifest is fetched once for both indexes when they are looked up together. */
const MANIFEST_SHARE_MS = 5 * 1000

/**
 * The published charts indexes per country. Located through the tile host's
 * manifest (content hash -> versioned URL, the way the apps fetch it, so a
 * stale edge copy of the bare URL is never used) and reloaded only when the
 * hash changes. A failed reload keeps serving the last good index. One
 * manifest download serves both kinds.
 */
export function createChartIndexResolver(cfg: ChartDocumentConfig, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
  type Manifest = { files?: Record<string, { sha256?: unknown }> }
  const cache = new Map<string, { index: ChartsIndex | null; sha: string | null; at: number }>()
  const inflight = new Map<string, Promise<ChartsIndex | null>>()
  const warned = new Set<string>()
  let manifestShared: { at: number; p: Promise<Manifest> } | null = null

  function manifest(): Promise<Manifest> {
    if (manifestShared && now() - manifestShared.at < MANIFEST_SHARE_MS) return manifestShared.p
    const p = fetchJson(`${cfg.tilesBaseUrl}/manifest.json`, MANIFEST_MAX_BYTES, cfg, fetchImpl) as Promise<Manifest>
    const mine = { at: now(), p }
    manifestShared = mine
    p.catch(() => { if (manifestShared === mine) manifestShared = null })
    return p
  }

  async function reload(cc: string, kind: ChartIndexKind): Promise<ChartsIndex | null> {
    const name = countryDatasetFile(cc, INDEX_DATASET[kind])
    const ck = `${kind}:${cc}`
    const prev = cache.get(ck)
    try {
      const m = await manifest()
      const sha = m?.files?.[name]?.sha256
      if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) {
        if (kind === 'public' && m?.files?.[`${cc}-charts.json`] && !warned.has(cc)) {
          warned.add(cc)
          console.warn(`[charts/document] ${cc}: the manifest lists ${cc}-charts.json but not ${name}: charts are published under the two new names now, no chart is served until they are published`)
        }
        cache.set(ck, { index: null, sha: null, at: now() })      // not published for this country
        return null
      }
      if (prev && prev.sha === sha) {
        prev.at = now()
        return prev.index
      }
      const index = parseChartsIndex(await fetchJson(`${cfg.tilesBaseUrl}/${name}?v=${sha.slice(0, 12)}`, INDEX_MAX_BYTES, cfg, fetchImpl))
      const ok = index && index.country === cc ? index : null
      cache.set(ck, { index: ok, sha, at: now() })
      return ok
    } catch (err) {
      console.error('[charts/document] index reload failed', { country: cc, kind, error: err instanceof Error ? err.message : String(err) })
      if (prev) {                                                  // keep serving the last good one, and do not retry on every request
        prev.at = now()
        return prev.index
      }
      throw err
    }
  }

  function load(cc: string, kind: ChartIndexKind): Promise<ChartsIndex | null> {
    const ck = `${kind}:${cc}`
    let p = inflight.get(ck)
    if (!p) {
      p = reload(cc, kind).finally(() => inflight.delete(ck))
      inflight.set(ck, p)
    }
    return p
  }

  return {
    /** The chart's document URL and display permission, or null when the index doesn't list it. */
    async resolve(cc: string, chartId: string, kind: ChartIndexKind = 'public'): Promise<{ url: string; document: boolean } | null> {
      const ck = `${kind}:${cc}`
      const hit = cache.get(ck)
      let index = hit && now() - hit.at < cfg.indexTtlMs ? hit.index : await load(cc, kind)
      let found = index ? findChart(index, chartId) : null
      const at = cache.get(ck)?.at ?? 0
      if (!found && now() - at >= MISS_RELOAD_MS) {               // maybe published since: look once more
        index = await load(cc, kind)
        found = index ? findChart(index, chartId) : null
      }
      return found && index ? { url: found.chart.url, document: index.display.document } : null
    },
  }
}

export function chartDocumentRoutes(opts: {
  requireUser: (c: Context) => Promise<{ id: string; role?: string | null } | null>
  config?: ChartDocumentConfig
  fetchImpl?: typeof fetch
}): Hono {
  const cfg = opts.config ?? chartDocumentConfigFromEnv()
  const limit = createRateLimiter(cfg.hourlyLimit, cfg.dailyLimit)
  const cache = createByteCache(cfg.cacheBytes, cfg.cacheTtlMs)
  const inflight = new Map<string, Promise<Uint8Array>>()
  const app = new Hono()

  const indexes = createChartIndexResolver(cfg, opts.fetchImpl)

  /** What the web client needs to know before it offers charts: a deployment may refuse every non-admin (CHART_DOCUMENT_ADMIN_ONLY).
   *  No secrets, no session needed. */
  app.get('/config', (c) => c.json({ adminOnly: !!cfg.adminOnly }))

  app.get('/document/:country/:chartId', async (c) => {
    if (cfg.hosts.size === 0 || !cfg.tilesBaseUrl) return c.json({ error: 'Not found' }, 404)
    const user = await opts.requireUser(c)
    if (!user) return c.json({ error: 'Authentication required.' }, 401)
    if (cfg.adminOnly && user.role !== 'admin') return c.json({ error: 'Not available for this account.' }, 403)
    const cc = c.req.param('country')
    const chartId = c.req.param('chartId')
    if (!/^[a-z]{2}$/.test(cc) || !CHART_ID.test(chartId)) return c.json({ error: 'Document not available.' }, 400)
    const rate = limit(user.id)
    if (!rate.allowed) {
      c.header('Retry-After', String(rate.retryAfterSeconds))
      return c.json({ error: 'Too many document requests. Try again later.', retryAfterSeconds: rate.retryAfterSeconds }, 429)
    }
    let entry: { url: string; document: boolean } | null = null
    let unavailable = false
    try {
      entry = await indexes.resolve(cc, chartId)
    } catch {
      unavailable = true
    }
    // Not in the public index (an airfield that is not released): only an admin may see it, from the preview index. A preview index
    // that cannot be loaded is logged (by the resolver) and counts as "not there": it must not turn an answer into a 503.
    if (!entry && user.role === 'admin') {
      try { entry = await indexes.resolve(cc, chartId, 'preview') } catch { /* logged by the resolver */ }
    }
    if (!entry && unavailable) return c.json({ error: 'Charts are unavailable right now.' }, 503)
    if (!entry || !entry.document) return c.json({ error: 'Document not found.' }, 404)
    const checked = checkDocumentUrl(entry.url, cfg.hosts)
    if ('error' in checked) {
      console.error('[charts/document] index lists a document this server may not fetch', { country: cc, chartId, url: entry.url, reason: checked.error })
      return c.json({ error: 'Document not found.' }, 404)
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

    let last = checked.url.pathname.split('/').pop() ?? 'document.pdf'
    try { last = decodeURIComponent(last) } catch { /* keep the raw name: it is only a suggested file name */ }
    const name = (last
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
