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
function tileHost(index: unknown, extra: Record<string, () => Response> = {}, sha = SHA, kind: 'public' | 'preview' = 'public') {
  return {
    [`${TILES}/manifest.json`]: () => Response.json({ files: { [`xx-charts.${kind}.json`]: { sha256: sha } } }),
    [`${TILES}/xx-charts.${kind}.json?v=${sha.slice(0, 12)}`]: () => Response.json(index),
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
  assert.equal(calls.filter(u => u.includes('xx-charts.public')).length, 1)

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

test('route: a chart only in the preview index (airfield not released) is for admins only; released ones are for every user', async () => {
  const pub = 'https://aip.example.org/charts/PUB.pdf'
  const hidden = 'https://aip.example.org/charts/HIDDEN.pdf'
  const publicIdx = chartsIndex([{ id: 'pub1', title: 'VAC', kind: 'VAC', url: pub }])
  const previewIdx = chartsIndex([{ id: 'pub1', title: 'VAC', kind: 'VAC', url: pub }, { id: 'hid1', title: 'VAC', kind: 'VAC', url: hidden }])
  // one manifest listing both files, each file under its own versioned URL
  const sha2 = 'cd'.repeat(32)
  const f = fakeFetch({
    [`${TILES}/manifest.json`]: () => Response.json({ files: { 'xx-charts.public.json': { sha256: SHA }, 'xx-charts.preview.json': { sha256: sha2 } } }),
    [`${TILES}/xx-charts.public.json?v=${SHA.slice(0, 12)}`]: () => Response.json(publicIdx),
    [`${TILES}/xx-charts.preview.json?v=${sha2.slice(0, 12)}`]: () => Response.json(previewIdx),
    [pub]: () => new Response(PDF), [hidden]: () => new Response(PDF),
  })
  const as = (role: string | null | undefined) =>
    chartDocumentRoutes({ requireUser: async () => ({ id: `u-${role}`, role }), config: { ...cfg, hourlyLimit: 100, dailyLimit: 100 }, fetchImpl: f })
  assert.equal((await as('user').request('/document/xx/pub1')).status, 200)        // released: everyone
  assert.equal((await as('user').request('/document/xx/hid1')).status, 404)        // not released: not for a normal user
  assert.equal((await as(null).request('/document/xx/hid1')).status, 404)
  assert.equal((await as('admin').request('/document/xx/hid1')).status, 200)       // admins see it
  assert.equal((await as('admin').request('/document/xx/pub1')).status, 200)
})

test('route: the preview index failing does not turn a public answer into a 503, and a failing public index is a 503 for everyone', async () => {
  const pub = 'https://aip.example.org/charts/PUB.pdf'
  const f = fakeFetch({
    [`${TILES}/manifest.json`]: () => Response.json({ files: { 'xx-charts.public.json': { sha256: SHA }, 'xx-charts.preview.json': { sha256: 'cd'.repeat(32) } } }),
    [`${TILES}/xx-charts.public.json?v=${SHA.slice(0, 12)}`]: () => Response.json(chartsIndex([{ id: 'pub1', title: 'VAC', kind: 'VAC', url: pub }])),
    // the preview index file itself is unreachable (500)
    [`${TILES}/xx-charts.preview.json?v=${'cd'.repeat(32).slice(0, 12)}`]: () => new Response('boom', { status: 500 }),
    [pub]: () => new Response(PDF),
  })
  const as = (role: string) => chartDocumentRoutes({ requireUser: async () => ({ id: `u-${role}`, role }), config: { ...cfg, hourlyLimit: 100, dailyLimit: 100 }, fetchImpl: f })
  assert.equal((await as('admin').request('/document/xx/pub1')).status, 200)
  assert.equal((await as('admin').request('/document/xx/missing1')).status, 404)         // preview unreachable: not found, not 503
  const down = fakeFetch({ [`${TILES}/manifest.json`]: () => new Response('nope', { status: 500 }) })
  const broken = (role: string) => chartDocumentRoutes({ requireUser: async () => ({ id: `d-${role}`, role }), config: { ...cfg, hourlyLimit: 100, dailyLimit: 100 }, fetchImpl: down })
  assert.equal((await broken('user').request('/document/xx/pub1')).status, 503)
  assert.equal((await broken('admin').request('/document/xx/pub1')).status, 503)         // nothing could answer
})

test('resolver: one manifest download serves both indexes; the old file name is called out once', async () => {
  const calls: string[] = []
  const warn: unknown[][] = []
  const orig = console.warn
  console.warn = (...a: unknown[]) => { warn.push(a) }
  try {
    const sha2 = 'cd'.repeat(32)
    const f = fakeFetch({
      [`${TILES}/manifest.json`]: () => Response.json({ files: { 'xx-charts.public.json': { sha256: SHA }, 'xx-charts.preview.json': { sha256: sha2 }, 'yy-charts.json': { sha256: SHA } } }),
      [`${TILES}/xx-charts.public.json?v=${SHA.slice(0, 12)}`]: () => Response.json(chartsIndex([{ id: 'pub1', title: 'VAC', kind: 'VAC', url: 'https://aip.example.org/p.pdf' }])),
      [`${TILES}/xx-charts.preview.json?v=${sha2.slice(0, 12)}`]: () => Response.json(chartsIndex([{ id: 'hid1', title: 'VAC', kind: 'VAC', url: 'https://aip.example.org/h.pdf' }])),
    }, calls)
    const r = createChartIndexResolver(cfg, f)
    assert.equal(await r.resolve('xx', 'hid1'), null)                        // a public miss ...
    assert.deepEqual(await r.resolve('xx', 'hid1', 'preview'), { url: 'https://aip.example.org/h.pdf', document: true })   // ... then the preview
    assert.equal(calls.filter(u => u.endsWith('/manifest.json')).length, 1)
    assert.equal(await r.resolve('yy', 'a1'), null)                          // yy still publishes the old name: no chart, and a warning
    assert.equal(await r.resolve('yy', 'a2'), null)
    assert.equal(warn.filter(a => String(a[0]).includes('yy-charts.json')).length, 1)
  } finally { console.warn = orig }
})

test('the api names itself when it reads the tile host (the edge may refuse anonymous datacenter requests)', async () => {
  const seen: Array<Record<string, string>> = []
  const f = (async (u: string | URL | Request, init?: RequestInit) => {
    seen.push((init?.headers ?? {}) as Record<string, string>)
    return Response.json({ files: {} })
  }) as typeof fetch
  await createChartIndexResolver(cfg, f).resolve('xx', 'nope')
  assert.ok(seen.length > 0)
  assert.match(String(seen[0]?.['User-Agent']), /^open-vfr\//)
})

test('route: GET /config tells the client whether non-admins are refused', async () => {
  const on = chartDocumentRoutes({ requireUser: async () => null, config: { ...cfg, adminOnly: true }, fetchImpl: fakeFetch({}) })
  const off = chartDocumentRoutes({ requireUser: async () => null, config: cfg, fetchImpl: fakeFetch({}) })
  assert.deepEqual(await (await on.request('/config')).json(), { adminOnly: true })
  assert.deepEqual(await (await off.request('/config')).json(), { adminOnly: false })      // no session needed
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
