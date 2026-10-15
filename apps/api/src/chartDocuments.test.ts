import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkDocumentUrl, createRateLimiter, createByteCache, fetchDocument, chartDocumentRoutes,
  type ChartDocumentConfig,
} from './chartDocuments.js'

const hosts = new Set(['aip.example.org'])
const cfg: ChartDocumentConfig = {
  hosts, maxBytes: 1024, hourlyLimit: 3, dailyLimit: 5, cacheBytes: 10_000, cacheTtlMs: 60_000, timeoutMs: 5_000,
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
  const f = fakeFetch({ [doc]: () => new Response(PDF) }, calls)
  const user = { id: 'u1' }
  const app = chartDocumentRoutes({ requireUser: async () => user, config: cfg, fetchImpl: f })
  const get = (url: string) => app.request(`/document?url=${encodeURIComponent(url)}`)

  const off = chartDocumentRoutes({ requireUser: async () => user, config: { ...cfg, hosts: new Set() }, fetchImpl: f })
  assert.equal((await off.request(`/document?url=${encodeURIComponent(doc)}`)).status, 404)
  const anon = chartDocumentRoutes({ requireUser: async () => null, config: cfg, fetchImpl: f })
  assert.equal((await anon.request(`/document?url=${encodeURIComponent(doc)}`)).status, 401)
  assert.equal((await get('https://evil.example/x.pdf')).status, 400)

  const res = await get(doc)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/pdf')
  assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PDF)
  assert.equal((await get(doc)).status, 200)
  assert.equal(calls.length, 1) // second request served from cache
  assert.equal((await get(doc)).status, 200) // 3rd counted request (the 400 above isn't counted)
  const limited = await get(doc) // 4th: over the hourly limit of 3
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
})
