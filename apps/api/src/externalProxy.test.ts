import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { handleProxy, newProxyState, takeUserMiss, upstreamWaitS, anonymousModeFromEnv, openMeteoWeight, openMeteoFreshUntil, readObservedQuota, usageLine, rotateHour, usageSnapshot, type HourSnapshot, OPEN_METEO, ELEVATION, type ProxySpec, type ProxyState } from './externalProxy.js'

const realFetch = globalThis.fetch
let calls: string[] = []
/** Default upstream: Open-Meteo shape -- one object per requested latitude
 *  (an object for one location, an array for several); others get {"ok":1}. */
const echo = (u: string) => {
  const lat = new URL(u).searchParams.get('latitude')
  if (!lat) return new Response('{"ok":1}', { status: 200 })
  const els = lat.split(',').map((la) => ({ ok: 1, lat: la }))
  return new Response(JSON.stringify(els.length === 1 ? els[0] : els), { status: 200 })
}
let reply: (u: string) => Response = echo

beforeEach(() => {
  calls = []
  reply = echo
  globalThis.fetch = (async (u: string | URL) => { calls.push(String(u)); return reply(String(u)) }) as typeof fetch
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
  assert.equal(await r2.text(), '{"ok":1,"lat":"59.30"}')
  assert.equal(calls.length, 1)
})

test('per location: only missing points go upstream, answers keep request order and shape', async () => {
  const s = newProxyState()
  const q = (lats: string) => `?latitude=${lats}&longitude=${lats.split(',').map(() => '17.70').join(',')}&current=wind_speed_10m&forecast_days=1`
  await om(s, q('59.30,59.35'), 'a')
  assert.equal(calls.length, 1)
  // Another user asks for an overlapping set: only 59.40 is fetched.
  const r = await om(s, q('59.40,59.30,59.35'), 'b')
  assert.equal(calls.length, 2)
  assert.equal(new URL(calls[1]!).searchParams.get('latitude'), '59.40')
  assert.deepEqual((JSON.parse(await r.text()) as { lat: string }[]).map((e) => e.lat), ['59.40', '59.30', '59.35'])
  // A single location is an object, served from the per-location cache.
  const one = await om(s, q('59.35'), 'c')
  assert.equal(one.headers.get('X-Cache'), 'HIT')
  assert.deepEqual(JSON.parse(await one.text()), { ok: 1, lat: '59.35' })
  assert.equal(calls.length, 2)
  // A different variable set is a different entry.
  await om(s, q('59.35').replace('wind_speed_10m', 'wind_speed_925hPa'), 'c')
  assert.equal(calls.length, 3)
})

test('per location: a point already being fetched for someone else is awaited, not refetched', async () => {
  const s = newProxyState()
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  globalThis.fetch = (async (u: string | URL) => { calls.push(String(u)); await gate; return echo(String(u)) }) as typeof fetch
  const q = (lats: string) => `?latitude=${lats}&longitude=${lats.split(',').map(() => '17.70').join(',')}&current=wind_speed_10m&forecast_days=1`
  const p1 = om(s, q('60.00,60.05'), 'a')
  await new Promise((r) => setTimeout(r, 0))
  const p2 = om(s, q('60.05,60.10'), 'b')   // 60.05 in flight; only 60.10 fetched
  await new Promise((r) => setTimeout(r, 0))
  release()
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1.status, 200)
  assert.deepEqual((JSON.parse(await r2.text()) as { lat: string }[]).map((e) => e.lat), ['60.05', '60.10'])
  assert.equal(calls.length, 2)
  assert.equal(new URL(calls[1]!).searchParams.get('latitude'), '60.10')
})

test('per location: a point that cannot be served fails the request (no partial answers)', async () => {
  const s = newProxyState()
  const q = (lats: string) => `?latitude=${lats}&longitude=${lats.split(',').map(() => '17.70').join(',')}&current=wind_speed_10m&forecast_days=1`
  await om(s, q('61.00'), 'a')
  reply = () => new Response('{"error":true,"reason":"overloaded"}', { status: 503 })
  const r = await om(s, q('61.00,61.05'), 'a')
  assert.equal(r.status, 503)
  assert.ok(Number(r.headers.get('Retry-After')) >= 1)
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

test('accepts every query shape the apps actually send', async () => {
  // Copied from real app requests (wind grid / gauge, winds aloft, leg
  // forecast, aerodrome weather station, terrain profile).
  const real = [
    '?latitude=59.30,59.35&longitude=17.70,17.75&current=wind_speed_925hPa,wind_direction_925hPa&wind_speed_unit=kn&forecast_days=1&timeformat=unixtime',
    '?latitude=59.55,59.50&longitude=18.25,18.05&current=wind_speed_10m,wind_direction_10m,wind_speed_925hPa,wind_direction_925hPa,wind_speed_850hPa,wind_direction_850hPa,wind_speed_700hPa,wind_direction_700hPa,wind_speed_600hPa,wind_direction_600hPa,wind_speed_500hPa,wind_direction_500hPa&wind_speed_unit=kn&forecast_days=1&timeformat=unixtime',
    '?latitude=59.60,59.45&longitude=18.25,18.20&hourly=wind_speed_925hPa,wind_direction_925hPa&wind_speed_unit=kn&forecast_days=5&past_days=1&timeformat=unixtime',
    '?latitude=59.6519&longitude=17.9186&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,cloud_cover,surface_pressure,precipitation&wind_speed_unit=kn&forecast_days=1&timeformat=unixtime',
  ]
  for (const q of real) {
    const r = await om(newProxyState(), q)
    assert.equal(r.status, 200, `${q} -> ${r.status} ${await r.text()}`)
  }
  const elev = await handleProxy(ELEVATION, newProxyState(), 'u', '/api/elevation/eudem25m', `?locations=${encodeURIComponent('59.48554,18.27164|59.48202,18.25557')}`)
  assert.equal(elev.status, 200)
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

test('anonymous mode env parsing defaults to off and fails closed', () => {
  assert.equal(anonymousModeFromEnv(undefined), 'off')
  assert.equal(anonymousModeFromEnv(''), 'off')
  assert.equal(anonymousModeFromEnv(' OFF '), 'off')
  assert.equal(anonymousModeFromEnv('yes'), 'off')
  assert.equal(anonymousModeFromEnv(' Limited '), 'limited')
})

test('closing an hour forgets callers with no miss in the last 24 h', () => {
  const s = newProxyState()
  const h0 = Date.UTC(2026, 0, 2, 10, 0, 0)
  const stats = { hourStart: h0, byOutcome: {}, users: new Set<string>(), anonymousIps: new Set<string>(), history: [] as HourSnapshot[] }
  s.userMisses.set('gone', [h0 - 25 * 3_600_000])
  s.userMisses.set('recent', [h0 - 25 * 3_600_000, h0 - 3_600_000])
  s.userMisses.set('empty', [])
  rotateHour(OPEN_METEO, s, stats, h0 + 3_600_000, false)
  assert.deepEqual([...s.userMisses.keys()], ['recent'])
})

test('Open-Meteo cost: per location max(1, V/10 x max(1, D/14)), fractional, summed', () => {
  const w = (qs: string) => openMeteoWeight(new URLSearchParams(qs))
  const v = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`).join(',')
  assert.equal(w('latitude=1&longitude=1&current=a,b&forecast_days=1'), 1)
  assert.equal(w('latitude=1,2,3&longitude=1,2,3&current=a,b&forecast_days=1'), 3)
  // 12 variables at 25 locations (winds-aloft batch): 25 x 1.2 = 30
  assert.equal(w(`latitude=${Array(25).fill(1)}&longitude=${Array(25).fill(1)}&current=${v(12)}&forecast_days=1`), 30)
  // Few variables over a long range stay at the minimum: 2 vars x 17 days = 0.2 x 1.21 < 1.
  assert.equal(w('latitude=1,2&longitude=1,2&hourly=a,b&forecast_days=16&past_days=1'), 2)
  // The provider's own examples (api-rate-limiting.md); 7 days when forecast_days is absent.
  assert.equal(w(`latitude=1&longitude=1&hourly=${v(5)}`), 1)
  assert.equal(w(`latitude=1&longitude=1&hourly=${v(15)}`), 1.5)
  assert.equal(w(`latitude=1,2,3&longitude=1,2,3&hourly=${v(15)}`), 4.5)
  assert.equal(w(`latitude=1&longitude=1&hourly=${v(10)}&forecast_days=16&past_days=2`), 18 / 14)
  assert.equal(w(`latitude=1&longitude=1&hourly=a&forecast_days=16&past_days=2`), 1)
  // A variable in both current and hourly counts twice.
  assert.equal(w(`latitude=1&longitude=1&current=${v(10)}&hourly=${v(10)}`), 2)
})

test('weighted calls count against the upstream budget and user caps', async () => {
  const spec: ProxySpec = { ...OPEN_METEO, perUser: { hourly: 30, daily: 100 }, upstream: { minIntervalMs: 0, maxInFlight: 2, perMinute: 40, hourly: 1000, daily: 1000 } }
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

test('per location: a current reading stays fresh until the next 15-min value is due', async () => {
  const s = newProxyState()
  let t = Date.UTC(2026, 0, 1, 10, 2, 0)
  const now = () => t
  const slotStart = Date.UTC(2026, 0, 1, 10, 0, 0) / 1000
  reply = () => new Response(JSON.stringify({ current: { time: slotStart, interval: 900, wind_speed_10m: 5 } }), { status: 200 })
  await om(s, Q, 'u', now)
  t += 10 * 60_000                                  // 10:12 -- past the old fixed 5 min
  assert.equal((await om(s, Q, 'u', now)).headers.get('X-Cache'), 'HIT')
  t += 5 * 60_000                                   // 10:17 -- next value (10:15) due
  assert.equal((await om(s, Q, 'u', now)).headers.get('X-Cache'), 'MISS')
  assert.equal(calls.length, 2)
  assert.equal(openMeteoFreshUntil('{"hourly":{}}', 1000), 1000 + 30 * 60_000)
  assert.equal(openMeteoFreshUntil('{"x":1}', 1000), undefined)
})

test('usage line summarises the hour without ids', () => {
  const s = newProxyState()
  const t = 50_000_000
  s.upstreamCalls = [{ t: t - 2 * 3_600_000, w: 1 }, { t: t - 1000, w: 1 }, { t: t - 500, w: 1.5 }]
  const line = usageLine(OPEN_METEO, s, { hourStart: t, byOutcome: { HIT: 7, MISS: 2 }, users: new Set(['secret-user']), anonymousIps: new Set(['9.9.9.9']), history: [] }, t)
  assert.match(line, /HIT=7 MISS=2; users 1, anonymous IPs 1; upstream calls \(weighted\) hour 2\.5\/4000, 24 h 3\.5\/9000; cache/)
  assert.doesNotMatch(line, /secret-user|9\.9\.9\.9/)
  s.observed = { remaining: 4321, limit: 5000, windowS: 3600, resetAt: t + 1000, seenAt: t }
  assert.match(usageLine(OPEN_METEO, s, { hourStart: t, byOutcome: {}, users: new Set(), anonymousIps: new Set(), history: [] }, t), /provider quota left 4321\/5000 \(3600 s window\)/)
})

test('clock-hour snapshots and the admin usage view (counts only)', () => {
  const s = newProxyState()
  const h0 = Date.UTC(2026, 0, 1, 10, 0, 0)
  const stats = { hourStart: h0, byOutcome: { HIT: 3, MISS: 1 }, users: new Set(['u1', 'u2']), anonymousIps: new Set(['1.2.3.4']), history: [] as HourSnapshot[] }
  s.upstreamCalls = [{ t: h0 + 1000, w: 1 }, { t: h0 + 2000, w: 1 }, { t: h0 + 3_700_000, w: 1 }]   // 2 in 10:00, 1 in 11:00
  s.anonUpstreamCalls = [h0 + 1000]
  rotateHour(OPEN_METEO, s, stats, h0 + 30 * 60_000, false)   // same hour: no-op
  assert.equal(stats.history.length, 0)
  const u = usageSnapshot(OPEN_METEO, s, stats, 'limited', h0 + 3_720_000)  // 11:02 -> closes 10:00
  assert.deepEqual(u.hours, [{ hourStart: '2026-01-01T10:00:00.000Z', outcomes: { HIT: 3, MISS: 1 }, users: 2, anonymousIps: 1, upstreamCalls: 2 }])
  assert.equal(u.currentHour.hourStart, '2026-01-01T11:00:00.000Z')
  assert.equal(u.currentHour.upstreamCalls, 1)
  assert.equal(u.upstream.lastHour, 1)        // rolling 10:02-11:02: only the 11:01 call
  assert.equal(u.upstream.last24h, 3)
  assert.deepEqual(u.anonymous, { last24h: 1, dailyCap: 1500 })
  assert.deepEqual(u.budget, { perMinute: 400, hourly: 4000, daily: 9000 })
  assert.equal(u.providerQuota, null)
  assert.deepEqual(u.inFlight, { active: 0, queued: 0, max: OPEN_METEO.upstream.maxInFlight })
  assert.doesNotMatch(JSON.stringify(u), /u1|u2|1\.2\.3\.4/)
})

test('server-wide upstream budget', () => {
  const spec: ProxySpec = { ...OPEN_METEO, upstream: { minIntervalMs: 0, maxInFlight: 2, perMinute: 2, hourly: 3, daily: 4 } }
  const s = newProxyState()
  const t = 9_000_000
  const at = (...ts: number[]) => ts.map((x) => ({ t: x, w: 1 }))
  s.upstreamCalls = at(t - 1000, t - 500)
  assert.ok(upstreamWaitS(s, spec, t) > 0 && upstreamWaitS(s, spec, t) <= 60)
  s.upstreamCalls = at(t - 3_000_000, t - 2_000_000, t - 120_000)
  assert.ok(upstreamWaitS(s, spec, t) > 60)
  s.upstreamCalls = at(t - 7_200_000)
  assert.equal(upstreamWaitS(s, spec, t), 0)
  // Fractional weights add up: 0.5 + 1.5 used of 2 per minute -> 0.5 more
  // fits once the oldest leaves (30 s), 0.6 only once both have (59 s).
  s.upstreamCalls = [{ t: t - 30_000, w: 0.5 }, { t: t - 1000, w: 1.5 }]
  assert.equal(upstreamWaitS(s, spec, t, 0.5), 30)
  assert.equal(upstreamWaitS(s, spec, t, 0.6), 59)
})

test('upstream: at most maxInFlight requests at a time; the rest wait their turn', async () => {
  const spec: ProxySpec = { ...OPEN_METEO, upstream: { ...OPEN_METEO.upstream, maxInFlight: 2 } }
  const s = newProxyState()
  let active = 0, peak = 0
  const pending: (() => void)[] = []
  globalThis.fetch = (async (u: string | URL) => {
    calls.push(String(u))
    active++; peak = Math.max(peak, active)
    await new Promise<void>((r) => pending.push(r))
    active--
    return echo(String(u))
  }) as typeof fetch
  const q = (lat: string) => `?latitude=${lat}&longitude=17.70&current=wind_speed_10m&forecast_days=1`
  const rs = ['61.00', '61.05', '61.10', '61.15', '61.20'].map((la, i) => handleProxy(spec, s, `u${i}`, '/api/open-meteo/forecast', q(la)))
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(calls.length, 2)
  assert.equal(s.slotWaiters.length, 3)
  while (pending.length > 0 || calls.length < 5) {
    pending.shift()?.()
    await new Promise((r) => setTimeout(r, 2))
  }
  const res = await Promise.all(rs)
  assert.deepEqual(res.map((r) => r.status), [200, 200, 200, 200, 200])
  assert.equal(calls.length, 5)
  assert.equal(peak, 2)
  assert.equal(s.inFlight, 0)
})

test('upstream: parallel throttled answers are one incident, not an escalating series', async () => {
  const s = newProxyState()
  let t = 2_000_000
  const now = () => t
  const pending: (() => void)[] = []
  globalThis.fetch = (async (u: string | URL) => {
    calls.push(String(u))
    await new Promise<void>((r) => pending.push(r))
    return new Response('{"error":true,"reason":"the service is overloaded"}', { status: 503 })
  }) as typeof fetch
  const q = (lat: string) => `?latitude=${lat}&longitude=17.70&current=wind_speed_10m&forecast_days=1`
  const rs = ['62.00', '62.05'].map((la, i) => om(s, q(la), `u${i}`, now))
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(calls.length, 2)                       // both out before either failed
  pending.forEach((r) => r())
  const res = await Promise.all(rs)
  assert.deepEqual(res.map((r) => r.status), [503, 503])
  assert.equal(s.consecutiveThrottles, 1)             // one incident
  // First backoff step: 5 s base, jittered within [2.5 s, 5 s] -- never the 15 s second step.
  assert.ok(s.pausedUntil - t >= 2_500 && s.pausedUntil - t <= 5_000, `paused ${s.pausedUntil - t} ms`)
  // A later throttle (sent after the pause began) does escalate.
  t = s.pausedUntil + 1
  globalThis.fetch = (async (u: string | URL) => { calls.push(String(u)); return new Response('{"error":true,"reason":"the service is overloaded"}', { status: 503 }) }) as typeof fetch
  await om(s, q('62.10'), 'u9', now)
  assert.equal(s.consecutiveThrottles, 2)
  assert.ok(s.pausedUntil - t >= 7_500 && s.pausedUntil - t <= 15_000)
})

test('upstream: a concurrency rejection pauses briefly and goes single file, no quota backoff', async () => {
  const s = newProxyState()
  let t = 3_000_000
  const now = () => t
  reply = () => new Response('{"error":true,"reason":"Too many concurrent requests"}', { status: 429 })
  const r = await om(s, Q, 'u', now)
  assert.equal(r.status, 503)
  assert.equal(s.consecutiveThrottles, 0)
  assert.ok(s.pausedUntil - t >= 1_500 && s.pausedUntil - t <= 3_000, `paused ${s.pausedUntil - t} ms`)
  assert.equal(s.singleFileUntil, t + 60_000)
  assert.equal(s.upstreamCalls.reduce((n, e) => n + e.w, 0), 0)   // not charged
  const u = usageSnapshot(OPEN_METEO, s, { hourStart: t - (t % 3_600_000), byOutcome: {}, users: new Set(), anonymousIps: new Set(), history: [] }, 'off', t)
  assert.equal(u.inFlight.max, 1)
  t += 61_000
  assert.equal(usageSnapshot(OPEN_METEO, s, { hourStart: t - (t % 3_600_000), byOutcome: {}, users: new Set(), anonymousIps: new Set(), history: [] }, 'off', t).inFlight.max, OPEN_METEO.upstream.maxInFlight)
})

test('upstream: the provider\'s reported cost and remaining quota steer the budget', async () => {
  const s = newProxyState()
  let t = Date.UTC(2026, 0, 1, 10, 0, 0)
  const now = () => t
  const resetAt = Math.floor(t / 1000) + 600
  const headers = (cost: string, remaining: string) => ({ 'X-RateLimit-Cost': cost, 'X-RateLimit-Limit': '5000', 'X-RateLimit-Remaining': remaining, 'X-RateLimit-Window': '3600', 'X-RateLimit-Reset': String(resetAt) })
  reply = () => new Response('{"ok":1,"lat":"59.30"}', { status: 200, headers: headers('2.5', '40') })
  assert.equal((await om(s, Q, 'u', now)).status, 200)
  assert.deepEqual(s.upstreamCalls.map((e) => e.w), [2.5])        // estimate 1 replaced by the reported cost
  // Enough left for a 1-call request; the next answer says 0.5 left.
  reply = () => new Response('{"ok":1,"lat":"59.35"}', { status: 200, headers: headers('1', '0.5') })
  assert.equal((await om(s, Q.replace('59.30', '59.35'), 'u', now)).status, 200)
  assert.equal(calls.length, 2)
  // Below the next request's weight: nothing goes upstream until the window resets.
  const r = await om(s, Q.replace('59.30', '59.40'), 'u', now)
  assert.equal(r.status, 503)
  assert.equal(Number(r.headers.get('Retry-After')), 600)
  assert.equal(calls.length, 2)
  const u = usageSnapshot(OPEN_METEO, s, { hourStart: t, byOutcome: {}, users: new Set(), anonymousIps: new Set(), history: [] }, 'off', t)
  assert.deepEqual(u.providerQuota, { remaining: 0.5, limit: 5000, windowS: 3600, resetAt: new Date(resetAt * 1000).toISOString() })
  assert.equal(u.upstream.lastHour, 3.5)
  t = resetAt * 1000 + 1
  assert.equal((await om(s, Q.replace('59.30', '59.40'), 'u', now)).status, 200)
  assert.equal(calls.length, 3)
  // Headers absent or partial: ignored.
  assert.equal(readObservedQuota(new Headers(), t), null)
  assert.equal(readObservedQuota(new Headers({ 'X-RateLimit-Remaining': '5' }), t), null)
  assert.deepEqual(readObservedQuota(new Headers({ 'X-RateLimit-Remaining': '5', 'X-RateLimit-Reset': '100' }), t), { remaining: 5, limit: null, windowS: null, resetAt: 100_000, seenAt: t })
})
