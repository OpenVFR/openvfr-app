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
 * explicitly allowed, and the response is never altered. It is STREAMED: the api never holds a document (a few chunks at most), so
 * a 20 MB chart costs the small container no memory; the size cap is enforced on the Content-Length and again while streaming,
 * and the first bytes must be %PDF- before anything is sent.
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
 *   CHART_DOCUMENT_CACHE_MB      no longer used: documents are streamed through, never held in memory or cached here
 *   CHART_DOCUMENT_ADMIN_ONLY    1/true: only accounts with role 'admin' may fetch documents at all (403 for others). Off by
 *                                default: every signed-in user may fetch the documents of the charts in the PUBLIC index
 *                                (`<cc>-charts.public.json`, released airfields); a chart that is only in the preview index
 *                                (`<cc>-charts.preview.json`, every airfield) is served to role 'admin' only (404 otherwise).
 */

import { Hono, type Context } from 'hono'
import { RateLimiter, limitFromEnv } from './rateLimiter.js'
import { CHART_ID, findChart, parseChartsIndex, type ChartsIndex } from '@open-vfr/shared/chartsIndex'
import { countryDatasetFile } from '@open-vfr/shared/countryData'
import { TILE_FETCH_HEADERS, readCapped, fetchTileManifestHashes } from './tileFetch.js'

export interface ChartDocumentConfig {
  hosts: Set<string>
  /** Tile host the `<cc>-charts.public.json` / `<cc>-charts.preview.json` indexes are published on ('' = disabled). */
  tilesBaseUrl: string
  /** How long a loaded index is trusted before the manifest is checked again. */
  indexTtlMs: number
  maxBytes: number
  hourlyLimit: number
  dailyLimit: number
  timeoutMs: number
  /** Only role 'admin' may fetch documents. Optional: absent = open to every signed-in user. */
  adminOnly?: boolean
}

export function chartDocumentConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ChartDocumentConfig {
  return {
    hosts: new Set((env['CHART_DOCUMENT_HOSTS'] ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean)),
    tilesBaseUrl: (env['TILES_BASE_URL'] ?? '').trim().replace(/\/+$/, ''),
    indexTtlMs: 10 * 60 * 1000,
    maxBytes: limitFromEnv('CHART_DOCUMENT_MAX_MB', 20, env) * 1024 * 1024,
    hourlyLimit: limitFromEnv('CHART_DOCUMENT_HOURLY_LIMIT', 120, env),
    dailyLimit: limitFromEnv('CHART_DOCUMENT_DAILY_LIMIT', 600, env),
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

class UpstreamError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

const upstreamError = (message: string, status: number) => new UpstreamError(message, status)
const readCappedUpstream = (res: Response, maxBytes: number) => readCapped(res, maxBytes, upstreamError)

export interface OpenedDocument {
  /** The publisher's bytes, validated at the start; errors the stream (the client sees a broken download) if the cap is passed. */
  body: ReadableStream<Uint8Array>
  /** The publisher's Content-Length when it sent one (already checked against the cap). */
  length: number | null
}

const PDF_MAGIC = '%PDF-'

/**
 * Open a document for streaming: at most one redirect, and only to another allowed URL; the status, the declared size and the first
 * bytes (%PDF-) are checked BEFORE anything is returned, so a bad document is still a clean error response. After that the bytes
 * flow chunk by chunk with the cap enforced as they pass, and a stalled publisher is cut off after `timeoutMs` without data
 * (the timeout covers the wait for the first bytes and then each gap, not the whole transfer to a slow client).
 */
export async function openDocument(url: URL, cfg: ChartDocumentConfig, fetchImpl: typeof fetch = fetch): Promise<OpenedDocument> {
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs) }
  const disarm = () => clearTimeout(timer)
  try {
    let current = url
    for (let hop = 0; hop < 2; hop++) {
      arm()
      const res = await fetchImpl(current, {
        redirect: 'manual',
        signal: ctrl.signal,
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
      if (res.status !== 200 || !res.body) {
        await res.body?.cancel().catch(() => undefined)
        throw new UpstreamError(`upstream HTTP ${res.status}`, res.status === 404 ? 404 : 502)
      }
      const declaredRaw = res.headers.get('content-length')
      const declared = declaredRaw !== null && /^\d+$/.test(declaredRaw) ? Number(declaredRaw) : null
      if (declared !== null && declared > cfg.maxBytes) {
        await res.body.cancel().catch(() => undefined)
        throw new UpstreamError(`body over cap (${declared} bytes declared)`, 413)
      }
      const reader = res.body.getReader()
      // The first bytes decide whether this is a PDF at all; nothing is sent before they are checked.
      const head: Uint8Array[] = []
      let size = 0
      let ended = false
      while (size < PDF_MAGIC.length && !ended) {
        const { done, value } = await reader.read()
        if (done) { ended = true; break }
        head.push(value)
        size += value.byteLength
      }
      const first = new Uint8Array(size)
      let off = 0
      for (const c of head) { first.set(c, off); off += c.byteLength }
      if (size > cfg.maxBytes) { ctrl.abort(); void reader.cancel().catch(() => undefined); throw new UpstreamError(`body over cap (${size} bytes read)`, 413) }
      if (new TextDecoder().decode(first.subarray(0, PDF_MAGIC.length)) !== PDF_MAGIC) {
        ctrl.abort(); void reader.cancel().catch(() => undefined)
        throw new UpstreamError('upstream body is not a PDF', 502)
      }
      disarm()
      let sent = size
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(first)
          if (ended) controller.close()
        },
        async pull(controller) {
          arm()
          try {
            const { done, value } = await reader.read()
            if (done) { disarm(); controller.close(); return }
            sent += value.byteLength
            if (sent > cfg.maxBytes) {
              disarm(); ctrl.abort(); void reader.cancel().catch(() => undefined)
              controller.error(new UpstreamError(`body over cap (${sent} bytes read)`, 413))
              return
            }
            controller.enqueue(value)
          } catch (err) {
            disarm()
            controller.error(err)
          }
        },
        cancel() {                                                   // the client went away: stop reading from the publisher
          disarm(); ctrl.abort()
          return reader.cancel().catch(() => undefined)
        },
      })
      return { body, length: declared }
    }
    throw new UpstreamError('too many redirects', 502)
  } catch (err) {
    disarm()
    ctrl.abort()
    throw err
  }
}

const INDEX_MAX_BYTES = 16 * 1024 * 1024
/** A chart id missing from a fresh-enough index triggers at most one reload per this interval. */
const MISS_RELOAD_MS = 60 * 1000

async function fetchJson(url: string, maxBytes: number, cfg: ChartDocumentConfig, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(cfg.timeoutMs), headers: { ...TILE_FETCH_HEADERS, Accept: 'application/json' } })
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined)
    throw new UpstreamError(`HTTP ${res.status} for ${url}`, 502)
  }
  return JSON.parse(new TextDecoder().decode(await readCappedUpstream(res, maxBytes)))
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
  type Hashes = Map<string, string>
  const cache = new Map<string, { index: ChartsIndex | null; sha: string | null; at: number }>()
  const inflight = new Map<string, Promise<ChartsIndex | null>>()
  const warned = new Set<string>()
  let manifestShared: { at: number; p: Promise<Hashes> } | null = null

  function manifest(): Promise<Hashes> {
    if (manifestShared && now() - manifestShared.at < MANIFEST_SHARE_MS) return manifestShared.p
    const p = fetchTileManifestHashes(cfg.tilesBaseUrl, { fetchImpl, timeoutMs: cfg.timeoutMs, makeError: upstreamError })
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
      const sha = m.get(name)
      if (!sha) {
        if (kind === 'public' && m.has(`${cc}-charts.json`) && !warned.has(cc)) {
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
    let doc: OpenedDocument
    try {
      doc = await openDocument(checked.url, cfg, opts.fetchImpl)
    } catch (err) {
      const status = err instanceof UpstreamError ? err.status : 502
      console.error('[charts/document] fetch failed', { url: key, status, error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined })
      return c.json({ error: status === 404 ? 'Document not found.' : 'Document unavailable.' }, status === 404 ? 404 : status === 413 ? 413 : 502)
    }

    let last = checked.url.pathname.split('/').pop() ?? 'document.pdf'
    try { last = decodeURIComponent(last) } catch { /* keep the raw name: it is only a suggested file name */ }
    const name = (last
      .replace(/[^\w.\- ]+/g, '_').slice(0, 120)) || 'document.pdf'
    return new Response(doc.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        ...(doc.length !== null ? { 'Content-Length': String(doc.length) } : {}),
        'Content-Disposition': `inline; filename="${name}"`,
        'Cache-Control': 'private, max-age=21600',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    })
  })

  return app
}
