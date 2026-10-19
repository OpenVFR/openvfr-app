import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { handleProxy, newProxyState, takeUserMiss, upstreamWaitS, anonymousModeFromEnv, openMeteoWeight, OPEN_METEO, ELEVATION, type ProxySpec, type ProxyState } from './externalProxy.js'

const realFetch = globalThis.fetch
let calls: string[] = []
let reply: () => Response = () => new Response('{"ok":1}', { status: 200 })

beforeEach(() => {
  calls = []
  reply = () => new Response('{"ok":1}', { status: 200 })
  globalThis.fetch = (async (u: string | URL) => { calls.push(String(u)); return reply() }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

const Q = '?latitude=59.30&longitude=17.70&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&forecast_days=1&timeformat=unixtime'
const om = (s: ProxyState, q = Q, user = 'u1', now?: () => number) => handleProxy(OPEN_METEO, s, user, '/api/open-meteo/forecast', q, now)

test('relays an allowed request and caches it per normalised query', async () => {
  const s = newProxyState()
  const r1 = await om(s)
  assert.equal(r1.status, 200)
  assert.equal(r1.headers.get('X-Cache'), 'MISS')
  assert.equal(calls.length, 1)
  assert.match(calls[0]!, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=59\.30&longitude=17\.70&current=/)
  // Same parameters in another order: same cache entry.
  const reordered = '?longitude=17.70&latitude=59.30&timeformat=unixtime&forecast_days=1&wind_speed_unit=kn&current=wind_speed_10m,wind_direction_10m'
  const r2 = await om(s, reordered, 'u2')
  assert.equal(r2.headers.get('X-Cache'), 'HIT')
  assert.equal(await r2.text(), '{"ok":1}')
  assert.equal(calls.length, 1)
})

test('rejects unknown endpoints, parameters and oversized coordinate lists', async () => {
  const s = newProxyState()
  assert.equal((await handleProxy(OPEN_METEO, s, 'u', '/api/open-meteo/archive', Q)).status, 404)
  assert.equal((await om(s, Q + '&apikey=x')).status, 400)
  const many = Array.from({ length: 26 }, () => '59.3').join(',')
  assert.equal((await om(s, `?latitude=${many}&longitude=${many}&current=wind_speed_10m`)).status, 400)
  assert.equal((await om(s, '?latitude=59.3&longitude=17.7')).status, 400)
  assert.equal((await om(s, '?latitude=59.3&longitude=17.7&current=a;b')).status, 400)
  const pts = Array.from({ length: 101 }, () => '59.3,17.7').join('|')
  assert.equal((await handleProxy(ELEVATION, s, 'u', '/api/elevation/eudem25m', `?locations=${encodeURIComponent(pts)}`)).status, 400)
  assert.equal(calls.length, 0)
})

test('identical concurrent misses make one upstream call', async () => {
  const s = newProxyState()
  const rs = await Promise.all([om(s, Q, 'a'), om(s, Q, 'b'), om(s, Q, 'c')])
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200])
  assert.equal(calls.length, 1)
})

test('an upstream 503 pauses all calls; stale entries are served meanwhile', async () => {
  const s = newProxyState()
  let t = 1_000_000
  const now = () => t
  await om(s, Q, 'u', now)                         // cached at t
  t += OPEN_METEO.freshMs + 1000                   // expired, within the stale window
  reply = () => new Response('{"error":true,"reason":"overloaded"}', { status: 503 })
  const r = await om(s, Q, 'u', now)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('X-Cache'), 'STALE')
  assert.ok(s.pausedUntil > t)
  // A different query while paused: no upstream call, 503 + Retry-After.
  const n = calls.length
  const r2 = await om(s, Q.replace('59.30', '59.35'), 'u', now)
  assert.equal(r2.status, 503)
  assert.ok(Number(r2.headers.get('Retry-After')) >= 1)
  assert.equal(calls.length, n)
})

test('upstream 4xx is passed through and not cached', async () => {
  const s = newProxyState()
  reply = () => new Response('{"error":true,"reason":"bad variable"}', { status: 400 })
  assert.equal((await om(s)).status, 400)
  reply = () => new Response('{"ok":2}', { status: 200 })
  assert.equal(await (await om(s)).text(), '{"ok":2}')
})

test('per-user miss quota; cache hits do not count', async () => {
  const spec: ProxySpec = { ...OPEN_METEO, perUser: { hourly: 2, daily: 3 } }
  const s = newProxyState()
  const t = 5_000_000
  assert.equal(takeUserMiss(s, spec, 'u', t), 0)
  assert.equal(takeUserMiss(s, spec, 'u', t + 1), 0)
  assert.ok(takeUserMiss(s, spec, 'u', t + 2) > 3500)       // hourly cap
  assert.equal(takeUserMiss(s, spec, 'other', t + 2), 0)    // per user
  assert.equal(takeUserMiss(s, spec, 'u', t + 3_600_001), 0)
  assert.ok(takeUserMiss(s, spec, 'u', t + 7_300_000) > 0)  // daily cap
  // Over quota with nothing cached: 429 + Retry-After, no upstream call.
  const s2 = newProxyState()
  for (let i = 0; i < 2; i++) takeUserMiss(s2, spec, 'u', Date.now())
  const r = await handleProxy(spec, s2, 'u', '/api/open-meteo/forecast', Q)
  assert.equal(r.status, 429)
  assert.equal(calls.length, 0)
})

test('anonymous callers: tight per-IP cap and a capped share of the upstream budget', async () => {
  const spec: ProxySpec = { ...OPEN_METEO, anonymous: { perIpHourly: 2, perIpDaily: 5, upstreamDaily: 3 } }
  const s = newProxyState()
  const q = (lat: string) => Q.replace('59.30', lat)
  const anon = (ip: string, lat: string) => handleProxy(spec, s, { kind: 'anonymous', ip }, '/api/open-meteo/forecast', q(lat))
  assert.equal((await anon('1.1.1.1', '59.31')).status, 200)
  assert.equal((await anon('1.1.1.1', '59.32')).status, 200)
  const capped = await anon('1.1.1.1', '59.33')                  // per-IP hourly cap
  assert.equal(capped.status, 429)
  assert.match(await capped.text(), /sign in/)
  assert.equal((await anon('1.1.1.1', '59.31')).status, 200)    // cache hits stay free
  assert.equal((await anon('2.2.2.2', '59.34')).status, 200)    // 3rd anonymous upstream call
  assert.equal((await anon('3.3.3.3', '59.35')).status, 429)    // anonymous share used up
  // Signed-in users are not affected by the anonymous share.
  assert.equal((await handleProxy(spec, s, 'u1', '/api/open-meteo/forecast', q('59.36'))).status, 200)
  assert.equal(calls.length, 4)
})

test('anonymous mode env parsing defaults to limited', () => {
  assert.equal(anonymousModeFromEnv(undefined), 'limited')
  assert.equal(anonymousModeFromEnv(''), 'limited')
  assert.equal(anonymousModeFromEnv(' OFF '), 'off')
  assert.equal(anonymousModeFromEnv('yes'), 'limited')
})

test('Open-Meteo cost: locations x variables/10 x days/14, rounded up', () => {
  const w = (qs: string) => openMeteoWeight(new URLSearchParams(qs))
  assert.equal(w('latitude=1&longitude=1&current=a,b&forecast_days=1'), 1)
  assert.equal(w('latitude=1,2,3&longitude=1,2,3&current=a,b&forecast_days=1'), 3)
  // 12 variables at 25 locations (winds-aloft batch): 25 x 1.2 = 30
  assert.equal(w(`latitude=${Array(25).fill(1)}&longitude=${Array(25).fill(1)}&current=${'v,'.repeat(11)}v&forecast_days=1`), 30)
  // 16 + 1 days of hourly data: 17/14 per location
  assert.equal(w('latitude=1,2&longitude=1,2&hourly=a,b&forecast_days=16&past_days=1'), 3)
})

test('weighted calls count against the upstream budget and user caps', async () => {
  const spec: ProxySpec = { ...OPEN_METEO, perUser: { hourly: 30, daily: 100 }, upstream: { minIntervalMs: 0, perMinute: 40, hourly: 1000, daily: 1000 } }
  const s = newProxyState()
  const many = (base: number) => Array.from({ length: 25 }, (_, i) => (base + i / 100).toFixed(2)).join(',')
  const q = (base: number) => `?latitude=${many(base)}&longitude=${many(10)}&current=wind_speed_10m&forecast_days=1`
  assert.equal((await handleProxy(spec, s, 'u', '/api/open-meteo/forecast', q(50))).status, 200)   // 25 of 30
  const r = await handleProxy(spec, s, 'u', '/api/open-meteo/forecast', q(51))                     // would be 50
  assert.equal(r.status, 429)
  assert.equal(calls.length, 1)
  // Another user: per-minute budget 40 can't fit a second 25.
  const r2 = await handleProxy(spec, s, 'v', '/api/open-meteo/forecast', q(52))
  assert.equal(r2.status, 503)
  assert.equal(calls.length, 1)
})

test('server-wide upstream budget', () => {
  const spec: ProxySpec = { ...OPEN_METEO, upstream: { minIntervalMs: 0, perMinute: 2, hourly: 3, daily: 4 } }
  const s = newProxyState()
  const t = 9_000_000
  s.upstreamCalls = [t - 1000, t - 500]
  assert.ok(upstreamWaitS(s, spec, t) > 0 && upstreamWaitS(s, spec, t) <= 60)
  s.upstreamCalls = [t - 3_000_000, t - 2_000_000, t - 120_000]
  assert.ok(upstreamWaitS(s, spec, t) > 60)
  s.upstreamCalls = [t - 7_200_000]
  assert.equal(upstreamWaitS(s, spec, t), 0)
})
