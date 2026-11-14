import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTileFileCache } from './tileFileCache.js'

const BASE = 'https://tiles.example.org'
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const tick = () => new Promise(r => setImmediate(r))

/** A tile host whose manifest and files the test changes; records every request. */
function setup(opts: { retryMs?: number } = {}) {
  const state = { files: { 'xx-airspace.geojson': A } as Record<string, string>, manifestUp: true, manifestHang: false, fileUp: true }
  const requests: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    requests.push(url)
    if (!state.manifestUp) throw new Error('down')
    if (state.manifestHang) return new Promise<Response>(() => {})
    return Response.json({ files: Object.fromEntries(Object.entries(state.files).map(([n, sha]) => [n, { sha256: sha, bytes: 1 }])) })
  }) as typeof fetch
  let t = 0
  const loads: string[] = []
  const cache = createTileFileCache<string>({
    baseUrl: BASE, fetchImpl, now: () => t, fallbackTtlMs: 6 * 3600_000, retryMs: opts.retryMs ?? 60_000,
    load: async (url) => { loads.push(url); return state.fileUp ? `data@${url}` : null },
  })
  const manifestCount = () => requests.filter(r => r.endsWith('manifest.json')).length
  return { state, requests, cache, loads, manifestCount, advance: (ms: number) => { t += ms } }
}
const v = (sha: string) => `data@${BASE}/xx-airspace.geojson?v=${sha.slice(0, 12)}`
const bare = `data@${BASE}/xx-airspace.geojson`

test('loads by the versioned URL and reuses it while the hash is unchanged', async () => {
  const s = setup()
  assert.equal(await s.cache.get('xx-airspace.geojson'), v(A))
  s.advance(10 * 60_000)
  await s.cache.get('xx-airspace.geojson'); await tick()
  assert.equal(s.loads.length, 1)
  assert.equal(s.manifestCount(), 2)
})

test('checks the manifest at most once per interval, shared by concurrent callers', async () => {
  const s = setup()
  await Promise.all([s.cache.get('xx-airspace.geojson'), s.cache.get('xx-airspace.geojson'), s.cache.get('xx-airspace.geojson')])
  s.advance(60_000)
  await s.cache.get('xx-airspace.geojson')
  assert.equal(s.manifestCount(), 1)
  assert.equal(s.loads.length, 1)
})

test('a cached file is returned without waiting for the manifest (revalidated in the background)', async () => {
  const s = setup()
  await s.cache.get('xx-airspace.geojson')
  s.state.manifestHang = true
  s.advance(5 * 60_000)
  assert.equal(await s.cache.get('xx-airspace.geojson'), v(A))   // would hang if it awaited the manifest
})

test('a new hash is picked up once the background check has run', async () => {
  const s = setup()
  await s.cache.get('xx-airspace.geojson')
  s.state.files['xx-airspace.geojson'] = B
  s.advance(5 * 60_000)
  assert.equal(await s.cache.get('xx-airspace.geojson'), v(A))   // stale while revalidating
  await tick()
  assert.equal(await s.cache.get('xx-airspace.geojson'), v(B))
})

test('a failed reload keeps the last good copy for every caller and is retried after retryMs only', async () => {
  const s = setup()
  await s.cache.get('xx-airspace.geojson')
  s.state.files['xx-airspace.geojson'] = B
  s.state.fileUp = false
  s.advance(5 * 60_000)
  await s.cache.get('xx-airspace.geojson'); await tick()
  const [a, b] = await Promise.all([s.cache.get('xx-airspace.geojson'), s.cache.get('xx-airspace.geojson')])
  assert.equal(a, v(A)); assert.equal(b, v(A))
  await s.cache.get('xx-airspace.geojson')
  assert.equal(s.loads.length, 2)                                // one failed attempt, no retry within retryMs
  s.state.fileUp = true
  s.advance(61_000)
  assert.equal(await s.cache.get('xx-airspace.geojson'), v(B))
})

test('without a manifest: bare URL with the fixed lifetime; a failed refetch keeps the copy and backs off', async () => {
  const s = setup()
  s.state.manifestUp = false
  assert.equal(await s.cache.get('xx-airspace.geojson'), bare)
  s.advance(5 * 60_000)
  await s.cache.get('xx-airspace.geojson')
  assert.equal(s.loads.length, 1)
  s.advance(6 * 3600_000)                                        // lifetime over, host down
  s.state.fileUp = false
  const [a, b] = await Promise.all([s.cache.get('xx-airspace.geojson'), s.cache.get('xx-airspace.geojson')])
  assert.equal(a, bare); assert.equal(b, bare)
  await s.cache.get('xx-airspace.geojson'); await s.cache.get('xx-airspace.geojson')
  assert.equal(s.loads.length, 2)                                // not refetched on every request
})

test('a file that disappears from the manifest is reloaded by its bare URL after the fallback lifetime', async () => {
  const s = setup()
  await s.cache.get('xx-airspace.geojson')
  delete s.state.files['xx-airspace.geojson']
  s.advance(5 * 60_000)
  await s.cache.get('xx-airspace.geojson'); await tick()
  assert.equal(await s.cache.get('xx-airspace.geojson'), v(A))   // kept within the lifetime
  s.advance(6 * 3600_000)
  await s.cache.get('xx-airspace.geojson'); await tick()
  assert.equal(await s.cache.get('xx-airspace.geojson'), bare)
})

test('an unreachable manifest keeps the last known versions', async () => {
  const s = setup()
  await s.cache.get('xx-airspace.geojson')
  s.state.manifestUp = false
  s.advance(5 * 60_000)
  await s.cache.get('xx-airspace.geojson'); await tick()
  assert.equal(await s.cache.get('xx-airspace.geojson'), v(A))
  assert.equal(s.loads.length, 1)
})

test('a file the manifest does not list is loaded by its bare URL', async () => {
  const s = setup()
  assert.equal(await s.cache.get('xx-lakes.geojson'), `data@${BASE}/xx-lakes.geojson`)
})
