import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { HttpRangeSource, lookupPoints, demAnswer, parseDemSources, createDemElevation, type DemArchive, type Archive } from './demElevation.js'
import { handleProxy, newProxyState, ELEVATION, type LocalSource } from './externalProxy.js'

// ── HttpRangeSource: never accept more than the slice asked for ────────────

const fakeFetch = (res: () => Response) => (async () => res()) as unknown as typeof fetch

test('range source returns a 206 slice', async () => {
  const src = new HttpRangeSource('https://tiles.example/x.pmtiles', fakeFetch(() =>
    new Response(new Uint8Array([1, 2, 3, 4]), { status: 206, headers: { 'Content-Length': '4', ETag: '"a"' } })))
  const r = await src.getBytes(100, 4)
  assert.deepEqual([...new Uint8Array(r.data)], [1, 2, 3, 4])
  assert.equal(r.etag, '"a"')
})

test('range source refuses a 200 (whole archive) without reading it', async () => {
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)) } })
  const src = new HttpRangeSource('https://tiles.example/x.pmtiles', fakeFetch(() =>
    new Response(body, { status: 200, headers: { 'Content-Length': '668248225' } })))
  await assert.rejects(src.getBytes(0, 16384), /HTTP 200/)
  assert.ok(pulled <= 2)
})

test('range source refuses a 206 larger than asked, and caps an unsized body', async () => {
  const big = new HttpRangeSource('u', fakeFetch(() => new Response(new Uint8Array(10), { status: 206, headers: { 'Content-Length': '10' } })))
  await assert.rejects(big.getBytes(0, 4), /HTTP 206/)
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(3)); c.enqueue(new Uint8Array(3)); c.close() } })
  const unsized = new HttpRangeSource('u', fakeFetch(() => new Response(stream, { status: 206 })))
  await assert.rejects(unsized.getBytes(0, 4), /more than/)
})

test('range source reports a replaced archive as an ETag mismatch', async () => {
  const src = new HttpRangeSource('u', fakeFetch(() => new Response(new Uint8Array(2), { status: 206, headers: { 'Content-Length': '2', ETag: '"new"' } })))
  await assert.rejects(src.getBytes(0, 2, undefined, '"old"'), (e: Error) => e.constructor.name === 'EtagMismatch')
})

// ── Lookup across archives ─────────────────────────────────────────────────

const box = (minLat: number, maxLat: number, elev: number | null): DemArchive & { reads: number } => ({
  reads: 0,
  async covers(lat) { return lat >= minLat && lat <= maxLat },
  async elevationM() { this.reads++; return elev },
})

test('each point is read from the archive covering it', async () => {
  const se = box(55, 69, 100), no = box(58, 72, 500)
  assert.deepEqual(await lookupPoints([se, no], [{ lat: 60, lng: 15 }, { lat: 70, lng: 20 }]), [100, 500])
})

test('a point outside every archive fails the whole lookup', async () => {
  assert.equal(await lookupPoints([box(55, 69, 100)], [{ lat: 60, lng: 15 }, { lat: 48, lng: 2 }]), null)
  assert.equal(await lookupPoints([], [{ lat: 60, lng: 15 }]), null)
})

test('covered nodata stays null; a read error fails the lookup', async () => {
  assert.deepEqual(await lookupPoints([box(55, 69, null)], [{ lat: 60, lng: 15 }]), [null])
  const broken: DemArchive = { covers: async () => true, elevationM: async () => { throw new Error('boom') } }
  assert.equal(await lookupPoints([broken], [{ lat: 60, lng: 15 }]), null)
})

test('answer has the OpenTopoData shape the apps parse', async () => {
  const body = JSON.parse((await demAnswer([box(55, 69, 123)], '59.1,18.2|59.2,18.3'))!)
  assert.equal(body.status, 'OK')
  assert.equal(body.results.length, 2)
  assert.equal(body.results[1].elevation, 123)
  assert.deepEqual(body.results[1].location, { lat: 59.2, lng: 18.3 })
})

test('ELEVATION_DEM_SOURCES parsing', () => {
  assert.equal(parseDemSources(undefined), 'auto')
  assert.equal(parseDemSources(' auto '), 'auto')
  assert.equal(parseDemSources('OFF'), 'off')
  assert.deepEqual(parseDemSources('https://t.example/se-hillshade.pmtiles, /data/no-hillshade.pmtiles'),
    ['https://t.example/se-hillshade.pmtiles', '/data/no-hillshade.pmtiles'])
})

// ── Proxy: local answers when upstream can't serve at once ─────────────────

const realFetch = globalThis.fetch
let upstreamCalls = 0
let upstream: () => Response = () => new Response('{"results":[{"elevation":10}],"status":"OK"}', { status: 200 })
beforeEach(() => {
  upstreamCalls = 0
  upstream = () => new Response('{"results":[{"elevation":10}],"status":"OK"}', { status: 200 })
  globalThis.fetch = (async () => { upstreamCalls++; return upstream() }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

const local = (body: string | null = '{"results":[{"elevation":99}],"status":"OK"}', perUser = { hourly: 1000, daily: 1000 }): LocalSource =>
  ({ answer: async () => body, perUser, anonymous: { hourly: 5, daily: 5 } })
const Q = (lat = '59.10000') => `?locations=${encodeURIComponent(`${lat},18.20000`)}`
const elev = (s = newProxyState(), q = Q(), l: LocalSource | null = local(), user = 'u', now?: () => number) =>
  handleProxy(ELEVATION, s, user, '/api/elevation/eudem25m', q, now, l)

test('upstream ready: upstream answers (finer data), local unused', async () => {
  const r = await elev()
  assert.equal(r.headers.get('X-Cache'), 'MISS')
  assert.equal(upstreamCalls, 1)
})

test('caller over its upstream quota: answered locally instead of 429', async () => {
  const s = newProxyState()
  const t = 1_000_000
  for (let i = 0; i < ELEVATION.perUser.hourly; i++) await elev(s, Q(`59.${String(10000 + i)}`), local(), 'u', () => t + i * 1200)
  const before = upstreamCalls
  const r = await elev(s, Q('60.00000'), local(), 'u', () => t + ELEVATION.perUser.hourly * 1200)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('X-Cache'), 'LOCAL')
  assert.equal(JSON.parse(await r.text()).results[0].elevation, 99)
  assert.equal(upstreamCalls, before)
})

test('upstream paused: answered locally without an upstream call', async () => {
  const s = newProxyState()
  s.pausedUntil = Date.now() + 60_000
  const r = await elev(s)
  assert.equal(r.headers.get('X-Cache'), 'LOCAL')
  assert.equal(upstreamCalls, 0)
})

test('upstream failing: answered locally', async () => {
  upstream = () => new Response('{"error":"down"}', { status: 500 })
  const r = await elev()
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('X-Cache'), 'LOCAL')
})

test('no local coverage: previous behaviour (503 when upstream is paused)', async () => {
  const s = newProxyState()
  s.pausedUntil = Date.now() + 60_000
  assert.equal((await elev(s, Q(), local(null))).status, 503)
  assert.equal((await elev(s, Q(), null)).status, 503)
})

test('local answers have their own cap', async () => {
  const s = newProxyState()
  s.pausedUntil = Date.now() + 60_000
  const l = local(undefined, { hourly: 2, daily: 2 })
  assert.equal((await elev(s, Q('59.1'), l)).headers.get('X-Cache'), 'LOCAL')
  assert.equal((await elev(s, Q('59.2'), l)).headers.get('X-Cache'), 'LOCAL')
  assert.equal((await elev(s, Q('59.3'), l)).status, 503)
})

const counting = (body: string | null, perUser = { hourly: 1000, daily: 1000 }) => {
  const l = { reads: 0, answer: async () => { l.reads++; return body }, perUser, anonymous: { hourly: 5, daily: 5 } }
  return l
}

test('over its local cap: no DEM read at all', async () => {
  const s = newProxyState()
  s.pausedUntil = Date.now() + 60_000
  const l = counting('{"results":[{"elevation":99}],"status":"OK"}', { hourly: 1, daily: 1 })
  assert.equal((await elev(s, Q('59.1'), l)).headers.get('X-Cache'), 'LOCAL')
  assert.equal(l.reads, 1)
  assert.equal((await elev(s, Q('59.2'), l)).status, 503)
  assert.equal(l.reads, 1)
})

test('one request reads the DEM at most once, whichever branches ask', async () => {
  const s = newProxyState()
  const t = 1_000_000
  for (let i = 0; i < ELEVATION.perUser.hourly; i++) await elev(s, Q(`59.${String(10000 + i)}`), null, 'u', () => t + i * 1200)
  s.nextSlotAt = t + ELEVATION.perUser.hourly * 1200 + 5_000   // long queue AND caller over quota
  const l = counting(null)
  const r = await elev(s, Q('60.00000'), l, 'u', () => t + ELEVATION.perUser.hourly * 1200)
  assert.equal(r.status, 429)
  assert.equal(l.reads, 1)
})

test('upstream paused and no local answer: 503 without charging the caller', async () => {
  const s = newProxyState()
  s.pausedUntil = Date.now() + 60_000
  await elev(s, Q(), counting(null))
  assert.equal(s.userMisses.get('u'), undefined)
  assert.equal(upstreamCalls, 0)
})

test('stale upstream answer beats the local DEM when the caller is over quota too', async () => {
  const s = newProxyState()
  let t = 1_000_000
  await elev(s, Q('59.5'), null, 'u', () => t)                  // cached
  t += ELEVATION.freshMs + 1000                                  // stale
  for (let i = 0; i < ELEVATION.perUser.hourly; i++) takeUserMissFill(s, t)
  const l = counting('{"results":[{"elevation":99}],"status":"OK"}')
  const r = await elev(s, Q('59.5'), l, 'u', () => t)
  assert.equal(r.headers.get('X-Cache'), 'STALE')
  assert.equal(l.reads, 0)
})

function takeUserMissFill(s: ReturnType<typeof newProxyState>, t: number) {
  const ts = s.userMisses.get('u') ?? []
  ts.push(t)
  s.userMisses.set('u', ts)
}

// ── DEM set: rebuild schedule ──────────────────────────────────────────────

const fakeArchive = (state: { readable: boolean; made: number; headerReads: number }) => () => {
  state.made++
  const dem = {
    async ready() { state.headerReads++; if (!state.readable) throw new Error('host down') },
    async covers() { if (!state.readable) throw new Error('host down'); return true },
    async elevationM() { return 42 },
    async elevationFt() { return 138 },
  }
  return { dem, source: new HttpRangeSource('u') } as unknown as Archive
}

test('registry down: retried on a schedule, not on every request', async () => {
  let t = 0, registryCalls = 0
  const f = createDemElevation({ sources: 'auto', tilesBaseUrl: 'https://t', now: () => t,
    countries: async () => { registryCalls++; return null },
    archive: fakeArchive({ readable: true, made: 0, headerReads: 0 }) })!
  for (let i = 0; i < 5; i++) assert.equal(await f('60,15'), null)
  assert.equal(registryCalls, 1)
  t += 3 * 60_000
  await f('60,15')
  assert.equal(registryCalls, 2)
})

test('tile host down at first build: retried within minutes, then answers', async () => {
  let t = 0
  const st = { readable: false, made: 0, headerReads: 0 }
  const f = createDemElevation({ sources: ['https://t/se-hillshade.pmtiles'], tilesBaseUrl: '', now: () => t,
    countries: async () => null, archive: fakeArchive(st) })!
  assert.equal(await f('60,15'), null)
  st.readable = true
  t += 3 * 60_000
  await f('60,15')                         // triggers the rebuild
  await new Promise((r) => setTimeout(r, 0))
  assert.ok((await f('60,15'))?.includes('"elevation":42'))
  assert.equal(st.made, 1)                 // same archive instance reused
})

test('hourly refresh reuses unchanged archives; all failing keeps the previous set', async () => {
  let t = 0
  const st = { readable: true, made: 0, headerReads: 0 }
  const f = createDemElevation({ sources: ['https://t/se-hillshade.pmtiles'], tilesBaseUrl: '', now: () => t,
    countries: async () => null, archive: fakeArchive(st) })!
  assert.ok(await f('60,15'))
  st.readable = false
  t += 61 * 60_000
  await f('60,15')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(st.made, 1)
  st.readable = true                       // previous set kept: still answers
  assert.ok((await f('60,15'))?.includes('"elevation":42'))
})
