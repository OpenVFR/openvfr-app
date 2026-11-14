import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTileFileCache } from './tileFileCache.js'

const BASE = 'https://tiles.example.org'
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

/** A tile host whose manifest and files the test changes; records every request. */
function host() {
  const state = { files: { 'xx-airspace.geojson': A } as Record<string, string>, manifestUp: true, fileUp: true }
  const requests: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith('/manifest.json')) {
      if (!state.manifestUp) throw new Error('down')
      return Response.json({ files: Object.fromEntries(Object.entries(state.files).map(([n, sha]) => [n, { sha256: sha, bytes: 1 }])) })
    }
    return new Response('{}')
  }) as typeof fetch
  return { state, requests, fetchImpl }
}

function setup() {
  const h = host()
  let t = 0
  const loads: string[] = []
  const cache = createTileFileCache<string>({
    baseUrl: BASE,
    fetchImpl: h.fetchImpl,
    now: () => t,
    fallbackTtlMs: 6 * 3600_000,
    load: async (url) => { loads.push(url); return h.state.fileUp ? `data@${url}` : null },
  })
  return { ...h, cache, loads, advance: (ms: number) => { t += ms } }
}

test('loads by the versioned URL and reuses it while the hash is unchanged', async () => {
  const s = setup()
  assert.equal(await s.cache.get('xx-airspace.geojson'), `data@${BASE}/xx-airspace.geojson?v=${A.slice(0, 12)}`)
  s.advance(10 * 60_000)                                    // past the manifest check interval: manifest again, same hash
  await s.cache.get('xx-airspace.geojson')
  assert.equal(s.loads.length, 1)
  assert.equal(s.requests.filter(r => r.endsWith('manifest.json')).length, 2)
})

test('checks the manifest at most once per interval, shared by concurrent callers', async () => {
  const s = setup()
  await Promise.all([s.cache.get('xx-airspace.geojson'), s.cache.get('xx-airspace.geojson'), s.cache.get('xx-airspace.geojson')])
  s.advance(60_000)
  await s.cache.get('xx-airspace.geojson')
  assert.equal(s.requests.filter(r => r.endsWith('manifest.json')).length, 1)
  assert.equal(s.loads.length, 1)
})

test('a new hash is picked up at the next manifest check', async () => {
  const s = setup()
  await s.cache.get('xx-airspace.geojson')
  s.state.files['xx-airspace.geojson'] = B
  s.advance(5 * 60_000)
  assert.equal(await s.cache.get('xx-airspace.geojson'), `data@${BASE}/xx-airspace.geojson?v=${B.slice(0, 12)}`)
})

test('a failed reload keeps the last good copy and is retried later, not on every call', async () => {
  const s = setup()
  await s.cache.get('xx-airspace.geojson')
  s.state.files['xx-airspace.geojson'] = B
  s.state.fileUp = false
  s.advance(5 * 60_000)
  assert.equal(await s.cache.get('xx-airspace.geojson'), `data@${BASE}/xx-airspace.geojson?v=${A.slice(0, 12)}`)
  await s.cache.get('xx-airspace.geojson')
  assert.equal(s.loads.length, 2)                          // one failed attempt, no retry within retryMs
  s.state.fileUp = true
  s.advance(5 * 60_000)
  assert.equal(await s.cache.get('xx-airspace.geojson'), `data@${BASE}/xx-airspace.geojson?v=${B.slice(0, 12)}`)
})

test('without a manifest it falls back to the bare URL with the fixed lifetime', async () => {
  const s = setup()
  s.state.manifestUp = false
  assert.equal(await s.cache.get('xx-airspace.geojson'), `data@${BASE}/xx-airspace.geojson`)
  s.advance(5 * 60_000)
  await s.cache.get('xx-airspace.geojson')
  assert.equal(s.loads.length, 1)
})

test('an unreachable manifest keeps the last known versions', async () => {
  const s = setup()
  await s.cache.get('xx-airspace.geojson')
  s.state.manifestUp = false
  s.advance(5 * 60_000)
  assert.equal(await s.cache.get('xx-airspace.geojson'), `data@${BASE}/xx-airspace.geojson?v=${A.slice(0, 12)}`)
  assert.equal(s.loads.length, 1)
})

test('a file the manifest does not list is loaded by its bare URL', async () => {
  const s = setup()
  assert.equal(await s.cache.get('xx-lakes.geojson'), `data@${BASE}/xx-lakes.geojson`)
})
