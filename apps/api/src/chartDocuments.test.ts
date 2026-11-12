import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkDocumentUrl, createRateLimiter, createByteCache, fetchDocument, chartDocumentRoutes, createChartIndexResolver,
  type ChartDocumentConfig,
} from './chartDocuments.js'

const hosts = new Set(['aip.example.org'])
const TILES = 'https://tiles.example.org'
const cfg: ChartDocumentConfig = {
  hosts, tilesBaseUrl: TILES, indexTtlMs: 600_000,
  maxBytes: 1024, hourlyLimit: 3, dailyLimit: 5, cacheBytes: 10_000, cacheTtlMs: 60_000, timeoutMs: 5_000,
}
const SHA = 'ab'.repeat(32)

function chartsIndex(charts: Array<Record<string, unknown>>, display = { document: true, overlay: true }) {
  return {
    schema: 'openvfr.charts/1', country: 'xx', cycle: '2026-10-29', source: { name: 'Example AIP', url: 'https://aip.example.org/' },
    display, aerodromes: { XXTT: { name: 'T', charts } },
  }
}

/** Tile host serving a manifest + versioned charts index, and the document host. */
function tileHost(index: unknown, extra: Record<string, () => Response> = {}, sha = SHA) {
  return {
    [`${TILES}/manifest.json`]: () => Response.json({ files: { 'xx-charts.json': { sha256: sha } } }),
    [`${TILES}/xx-charts.json?v=${sha.slice(0, 12)}`]: () => Response.json(index),
    ...extra,
  }
}
const PDF = new TextEncoder().encode('%PDF-1.7 test document')

function fakeFetch(responses: Record<string, () => Response>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const u = String(input instanceof Request ? input.url : input)
    calls.push(u)
    const r = responses[u]
    return r ? r() : new Response('nope', { status: 404 })
  }) as typeof fetch
}

test('url check: only https, allowed host, .pdf path', () => {
  assert.ok('url' in checkDocumentUrl('https://aip.example.org/charts/ES%20VAC.pdf', hosts))
  for (const bad of [
    undefined, '', 'not a url', 'http://aip.example.org/a.pdf', 'https://evil.example/a.pdf',
    'https://aip.example.org.evil.example/a.pdf', 'https://user:pw@aip.example.org/a.pdf',
    'https://aip.example.org:8443/a.pdf', 'https://aip.example.org/a.html', 'file:///etc/passwd',
    'https://169.254.169.254/latest.pdf',
  ]) {
    assert.ok('error' in checkDocumentUrl(bad, hosts), String(bad))
  }
})

test('rate limiter: hourly then daily caps', () => {
  let now = 0
  const limit = createRateLimiter(2, 3, () => now)
  assert.equal(limit('u').allowed, true)
  assert.equal(limit('u').allowed, true)
  assert.equal(limit('u').allowed, false)
  assert.equal(limit('other').allowed, true)
  now = 61 * 60 * 1000
  assert.equal(limit('u').allowed, true)
  now = 2 * 61 * 60 * 1000
  assert.equal(limit('u').allowed, false) // daily cap of 3 reached
})

test('byte cache: LRU eviction by size and TTL', () => {
  let now = 0
  const c = createByteCache(40, 1000, () => now)
  c.set('a', new Uint8Array(10)); c.set('b', new Uint8Array(10)); c.set('c', new Uint8Array(10))
  c.get('a')
  c.set('d', new Uint8Array(10)); c.set('e', new Uint8Array(10))
  assert.equal(c.get('b'), null) // least recently used went first
  assert.ok(c.get('a'))
  c.set('huge', new Uint8Array(30)) // over a quarter of the cache: not stored
  assert.equal(c.get('huge'), null)
  now = 2000
  assert.equal(c.get('a'), null)
})

test('fetch: passes a PDF through, refuses non-PDF, size cap and foreign redirects', async () => {
  const u = new URL('https://aip.example.org/a.pdf')
  assert.deepEqual(await fetchDocument(u, cfg, fakeFetch({ [u.href]: () => new Response(PDF) })), PDF)
  await assert.rejects(fetchDocument(u, cfg, fakeFetch({ [u.href]: () => new Response('<html>') })), /not a PDF/)
  await assert.rejects(fetchDocument(u, cfg, fakeFetch({ [u.href]: () => new Response(new Uint8Array(2048)) })), /over cap/)
  const redirectTo = (loc: string) => () => new Response(null, { status: 302, headers: { location: loc } })
  await assert.rejects(fetchDocument(u, cfg, fakeFetch({ [u.href]: redirectTo('https://evil.example/a.pdf') })), /redirect refused/)
  const ok = 'https://aip.example.org/b.pdf'
  assert.deepEqual(await fetchDocument(u, cfg, fakeFetch({ [u.href]: redirectTo('/b.pdf'), [ok]: () => new Response(PDF) })), PDF)
})

test('route: disabled, auth, validation, rate limit, caching, headers', async () => {
  const calls: string[] = []
  const doc = 'https://aip.example.org/charts/VAC.pdf'
  const index = chartsIndex([
    { id: 'vac1', title: 'VAC', kind: 'VAC', url: doc },
    { id: 'evil', title: 'Elsewhere', kind: 'ADC', url: 'https://evil.example/x.pdf' },
  ])
  const f = fakeFetch(tileHost(index, { [doc]: () => new Response(PDF) }), calls)
  const user = { id: 'u1' }
  const app = chartDocumentRoutes({ requireUser: async () => user, config: cfg, fetchImpl: f })
  const get = (path: string) => app.request(`/document/${path}`)

  const off = chartDocumentRoutes({ requireUser: async () => user, config: { ...cfg, hosts: new Set() }, fetchImpl: f })
  assert.equal((await off.request('/document/xx/vac1')).status, 404)
  const noTiles = chartDocumentRoutes({ requireUser: async () => user, config: { ...cfg, tilesBaseUrl: '' }, fetchImpl: f })
  assert.equal((await noTiles.request('/document/xx/vac1')).status, 404)
  const anon = chartDocumentRoutes({ requireUser: async () => null, config: cfg, fetchImpl: f })
  assert.equal((await anon.request('/document/xx/vac1')).status, 401)
  assert.equal((await get('XX/vac1')).status, 400)            // bad country (not counted)
  assert.equal((await get('xx/a.b')).status, 400)             // bad id (not counted)
  assert.equal((await app.request('/document?url=' + encodeURIComponent(doc))).status, 404)   // the URL form is gone

  const res = await get('xx/vac1')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/pdf')
  assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PDF)
  assert.equal((await get('xx/evil')).status, 404)            // listed, but its host isn't allowed
  assert.equal((await get('xx/vac1')).status, 200)            // 3rd counted request, from both caches
  assert.equal(calls.filter(u => u === doc).length, 1)
  assert.equal(calls.filter(u => u.endsWith('/manifest.json')).length, 1)
  const limited = await get('xx/vac1')                        // 4th: over the hourly limit of 3
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
})

test('index resolver: by manifest hash, unknown ids, viewing not allowed, stale on failure', async () => {
  let t = 0
  const now = () => t
  const calls: string[] = []
  let routes = tileHost(chartsIndex([{ id: 'vac1', title: 'VAC', kind: 'VAC', url: 'https://aip.example.org/v.pdf' }]))
  const f = fakeFetch(new Proxy({}, { get: (_, k: string) => routes[k as keyof typeof routes] }), calls)
  const r = createChartIndexResolver(cfg, f, now)

  assert.deepEqual(await r.resolve('xx', 'vac1'), { url: 'https://aip.example.org/v.pdf', document: true })
  assert.equal(await r.resolve('yy', 'vac1'), null)                       // no index published for yy
  assert.equal(await r.resolve('xx', 'nope'), null)                       // fresh index: no extra reload
  assert.equal(calls.filter(u => u.includes('xx-charts')).length, 1)

  t = 61_000                                                              // a miss after a minute looks again
  const sha2 = 'cd'.repeat(32)
  routes = tileHost(chartsIndex([{ id: 'new2', title: 'VAC', kind: 'VAC', url: 'https://aip.example.org/w.pdf' }]), {}, sha2)
  assert.deepEqual(await r.resolve('xx', 'new2'), { url: 'https://aip.example.org/w.pdf', document: true })

  t = 2_000_000                                                           // TTL over, tile host down: keep the last index
  routes = {} as typeof routes
  assert.deepEqual(await r.resolve('xx', 'new2'), { url: 'https://aip.example.org/w.pdf', document: true })

  const r2 = createChartIndexResolver(cfg, fakeFetch(tileHost(chartsIndex(
    [{ id: 'vac1', title: 'VAC', kind: 'VAC', url: 'https://aip.example.org/v.pdf' }], { document: false, overlay: false }))), now)
  assert.deepEqual(await r2.resolve('xx', 'vac1'), { url: 'https://aip.example.org/v.pdf', document: false })
  const r3 = createChartIndexResolver(cfg, fakeFetch({}), now)
  await assert.rejects(r3.resolve('xx', 'vac1'))                          // nothing cached and the host is down
})

test('route: adminOnly refuses every account that is not an admin (403), admits admins, and is off by default', async () => {
  const doc = 'https://aip.example.org/charts/VAC.pdf'
  const f = fakeFetch(tileHost(chartsIndex([{ id: 'vac1', title: 'VAC', kind: 'VAC', url: doc }]), { [doc]: () => new Response(PDF) }))
  const open = (role: string | null | undefined, adminOnly?: boolean) =>
    chartDocumentRoutes({ requireUser: async () => ({ id: 'u1', role }), config: { ...cfg, hourlyLimit: 100, dailyLimit: 100, adminOnly }, fetchImpl: f })
  assert.equal((await open('user', true).request('/document/xx/vac1')).status, 403)
  assert.equal((await open(null, true).request('/document/xx/vac1')).status, 403)
  assert.equal((await open(undefined, true).request('/document/xx/vac1')).status, 403)
  assert.equal((await open('admin', true).request('/document/xx/vac1')).status, 200)
  assert.equal((await open('user').request('/document/xx/vac1')).status, 200)         // not restricted unless asked for
})

test('config: CHART_DOCUMENT_ADMIN_ONLY', async () => {
  const { chartDocumentConfigFromEnv } = await import('./chartDocuments.js')
  assert.equal(chartDocumentConfigFromEnv({ CHART_DOCUMENT_ADMIN_ONLY: '1' }).adminOnly, true)
  assert.equal(chartDocumentConfigFromEnv({ CHART_DOCUMENT_ADMIN_ONLY: 'TRUE' }).adminOnly, true)
  assert.equal(chartDocumentConfigFromEnv({ CHART_DOCUMENT_ADMIN_ONLY: '0' }).adminOnly, false)
  assert.equal(chartDocumentConfigFromEnv({}).adminOnly, false)
})

test('config: an empty or invalid number means the default, never 0 (which would refuse every request)', async () => {
  const { chartDocumentConfigFromEnv } = await import('./chartDocuments.js')
  const c = chartDocumentConfigFromEnv({ CHART_DOCUMENT_HOURLY_LIMIT: '', CHART_DOCUMENT_DAILY_LIMIT: 'x', CHART_DOCUMENT_MAX_MB: ' ', CHART_DOCUMENT_CACHE_MB: '' })
  assert.equal(c.hourlyLimit, 120)
  assert.equal(c.dailyLimit, 600)
  assert.equal(c.maxBytes, 20 * 1024 * 1024)
  assert.equal(c.cacheBytes, 100 * 1024 * 1024)
  assert.equal(chartDocumentConfigFromEnv({ CHART_DOCUMENT_CACHE_MB: '0' }).cacheBytes, 0)      // 0 = cache off stays possible
})

test('url check: a malformed percent escape is refused, not thrown', () => {
  assert.deepEqual(checkDocumentUrl('https://aro.example/a%zz.pdf', new Set(['aro.example'])), { error: 'bad path encoding' })
})
