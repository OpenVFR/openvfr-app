/**
 * externalProxy — authenticated, rate-limited, cached relay to the free
 * third-party APIs the apps use for model wind and terrain:
 *
 *   GET /api/open-meteo/forecast?...    -> https://api.open-meteo.com/v1/forecast
 *   GET /api/elevation/eudem25m?...     -> https://api.opentopodata.org/v1/eudem25m
 *
 * These used to be nginx-level proxies with no auth at all. Both upstreams
 * limit calls PER IP, and every user's request leaves through this server's
 * one IP, so all users share one small budget (Open-Meteo: 600/min,
 * 5 000/h, 10 000/day; OpenTopoData: 1 call/s, 1 000/day). One anonymous
 * script asking for a different coordinate each time could exhaust a whole
 * day in minutes. Here requests are tied to a session, and:
 *
 *  - TRANSITION: requests without a session are still served while app
 *    builds that predate this proxy are in use (they send no session on
 *    these paths), but per client IP with tight caps and a capped share of
 *    the upstream budget, so they can't starve signed-in users. Set
 *    EXTERNAL_PROXY_ANONYMOUS=off to require a session (401) once those
 *    builds are gone;
 *
 *  - only the endpoint and query parameters the apps actually send are
 *    accepted (no open relay), with bounded coordinate counts;
 *  - responses are cached per normalised query (Open-Meteo 5 min, terrain
 *    7 days), identical concurrent misses share one upstream call;
 *  - each user has an hourly + daily cap on cache MISSES (hits are free);
 *  - the server keeps total upstream calls under the free-tier limits
 *    (minimum spacing + per-minute/hour/day budgets), and a 429/503 from
 *    upstream pauses all calls to it (Retry-After, else backoff);
 *  - when upstream can't be asked (paused, over budget, failing), the last
 *    good response is served if it is recent enough (Open-Meteo 1 h, terrain
 *    30 days), else 503 with Retry-After -- which the apps' own gate
 *    (@open-vfr/shared/openMeteo) honours.
 *
 * In-memory and per-process, like the POH limiter: fine for one instance.
 */

import type { Context } from 'hono'
import { throttleDelayMs, currentExpiresAt } from '@open-vfr/shared/openMeteo'

export interface ProxySpec {
  name: string
  /** Public path prefix, e.g. '/api/open-meteo/'. */
  prefix: string
  upstreamBase: string
  /** Endpoint (path after the prefix) -> allowed query parameters. */
  endpoints: Record<string, readonly string[]>
  /** Validates one query: returns an error message, or null when acceptable. */
  validate: (endpoint: string, q: URLSearchParams) => string | null
  /** Cache and fetch per location (latitude/longitude lists), see handlePerLocation. */
  perLocation?: boolean
  /** How many upstream "calls" one request costs against the provider's
   *  limits (all budgets and caps below are in these units). */
  weight: (endpoint: string, q: URLSearchParams) => number
  freshMs: number
  staleMs: number
  maxCacheBytes: number
  perUser: { hourly: number; daily: number }
  /** Requests without a session (transition mode, see ANONYMOUS_MODE):
   *  caps per client IP, and the most upstream calls per day they may cause
   *  in total, so they can never use up the budget signed-in users need. */
  anonymous: { perIpHourly: number; perIpDaily: number; upstreamDaily: number }
  upstream: { minIntervalMs: number; perMinute: number; hourly: number; daily: number }
  timeoutMs: number
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** Upstream pauses longer than this are reported to the client instead of waited out. */
const MAX_PAUSE_REPORT_S = 3600
/** Longest a request waits for an upstream slot (minIntervalMs spacing). */
const MAX_QUEUE_MS = 10_000

const COORD = /^-?\d{1,3}(\.\d{1,6})?$/
// Open-Meteo variable names, e.g. wind_speed_10m, wind_direction_925hPa.
const VARS = /^[A-Za-z0-9_]{1,40}(,[A-Za-z0-9_]{1,40}){0,24}$/

/** Open-Meteo cost of one request in calls (see OPEN_METEO.weight). Exported for tests. */
export function openMeteoWeight(q: URLSearchParams): number {
  const locations = (q.get('latitude') ?? '').split(',').filter(Boolean).length || 1
  const vars = ['current', 'hourly'].reduce((n, k) => n + (q.get(k)?.split(',').filter(Boolean).length ?? 0), 0)
  const days = Number(q.get('forecast_days') ?? 7) + Number(q.get('past_days') ?? 0)
  return Math.ceil(locations * Math.max(1, vars / 10) * Math.max(1, days / 14))
}

function coordList(v: string | null, max: number, lo: number, hi: number): boolean {
  if (!v) return false
  const parts = v.split(',')
  return parts.length <= max && parts.every((p) => COORD.test(p) && Math.abs(Number(p)) <= hi && Number(p) >= lo)
}

export const OPEN_METEO: ProxySpec = {
  name: 'open-meteo',
  prefix: '/api/open-meteo/',
  upstreamBase: 'https://api.open-meteo.com/v1/',
  endpoints: {
    forecast: ['latitude', 'longitude', 'current', 'hourly', 'wind_speed_unit', 'forecast_days', 'past_days', 'timeformat'],
  },
  validate(_endpoint, q) {
    // MAX_BATCH in fetchWind/windForecast is 25 points per request.
    const lat = q.get('latitude'), lng = q.get('longitude')
    if (!coordList(lat, 25, -90, 90) || !coordList(lng, 25, -180, 180)) return 'latitude/longitude: up to 25 comma-separated coordinates'
    if (lat!.split(',').length !== lng!.split(',').length) return 'latitude and longitude counts differ'
    const current = q.get('current'), hourly = q.get('hourly')
    if (!current && !hourly) return 'current or hourly is required'
    if (current && !VARS.test(current)) return 'current: invalid variable list'
    if (hourly && !VARS.test(hourly)) return 'hourly: invalid variable list'
    for (const [k, max] of [['forecast_days', 16], ['past_days', 2]] as const) {
      const v = q.get(k)
      if (v != null && !(/^\d{1,2}$/.test(v) && Number(v) <= max)) return `${k}: 0-${max}`
    }
    const unit = q.get('wind_speed_unit')
    if (unit != null && !['kn', 'kmh', 'ms', 'mph'].includes(unit)) return 'wind_speed_unit: kn|kmh|ms|mph'
    const tf = q.get('timeformat')
    if (tf != null && !['unixtime', 'iso8601'].includes(tf)) return 'timeformat: unixtime|iso8601'
    return null
  },
  // Matches the apps' own refetch rule (currentExpiresAt: next 15-min value);
  // the stale window matches their 1 h failure-only fallback.
  // Open-Meteo counts a request with N locations as N calls, more than 10
  // variables or more than 14 days as proportionally more (pricing FAQ:
  // fractional counts; its cost calculator takes variables, time span and
  // locations). Rounded up so a budget is never under-counted.
  weight: (_endpoint, q) => openMeteoWeight(q),
  perLocation: true,
  // Fallback only: per location, freshness follows the data
  // (openMeteoFreshUntil: next 15-min "current" value, hourly series 30 min).
  // The stale window matches the apps' 1 h failure-only fallback.
  freshMs: 5 * MINUTE_MS,
  staleMs: HOUR_MS,
  maxCacheBytes: 64 * 1024 * 1024,
  // In weighted calls. One map view of the wind grid is up to ~36 locations.
  perUser: { hourly: 600, daily: 2000 },
  anonymous: { perIpHourly: 100, perIpDaily: 300, upstreamDaily: 1500 },
  // Free tier: 600/min, 5 000/h, 10 000/day per IP (weighted) -- with a margin.
  upstream: { minIntervalMs: 0, perMinute: 400, hourly: 4000, daily: 9000 },
  timeoutMs: 15_000,
}

export const ELEVATION: ProxySpec = {
  name: 'elevation',
  prefix: '/api/elevation/',
  upstreamBase: 'https://api.opentopodata.org/v1/',
  endpoints: { eudem25m: ['locations'] },
  // OpenTopoData limits requests (up to 100 locations each), not locations.
  weight: () => 1,
  validate(_endpoint, q) {
    const loc = q.get('locations')
    if (!loc) return 'locations is required'
    const pts = loc.split('|')
    // OpenTopoData's own maximum per request.
    if (pts.length > 100) return 'locations: at most 100 points'
    for (const p of pts) {
      const [a, b, extra] = p.split(',')
      if (extra !== undefined || !coordList(a ?? null, 1, -90, 90) || !coordList(b ?? null, 1, -180, 180)) return 'locations: lat,lng|lat,lng|...'
    }
    return null
  },
  // Terrain does not change: cache long, serve old answers freely on failure.
  freshMs: 7 * DAY_MS,
  staleMs: 30 * DAY_MS,
  maxCacheBytes: 32 * 1024 * 1024,
  // The shared daily budget is only 1 000 calls; the apps fall back to a
  // local DEM (hillshade tiles) when this answers 429/503.
  perUser: { hourly: 120, daily: 400 },
  anonymous: { perIpHourly: 20, perIpDaily: 60, upstreamDaily: 150 },
  // Public OpenTopoData: max 1 call/s, 1 000/day.
  upstream: { minIntervalMs: 1100, perMinute: 50, hourly: 400, daily: 900 },
  timeoutMs: 20_000,
}

/** freshUntil: absolute end of freshness (default storedAt + spec.freshMs);
 *  the stale window runs spec.staleMs past it. */
interface CacheEntry { body: string; storedAt: number; bytes: number; freshUntil?: number }

const isFresh = (e: CacheEntry, spec: ProxySpec, t: number) => t < (e.freshUntil ?? e.storedAt + spec.freshMs)
const isUsableStale = (e: CacheEntry, spec: ProxySpec, t: number) => t < (e.freshUntil ?? e.storedAt + spec.freshMs) + spec.staleMs

/** Hourly forecast series change with model runs (hourly or slower). */
const HOURLY_FRESH_MS = 30 * MINUTE_MS

/**
 * Freshness of one Open-Meteo location element: a "current" block is fresh
 * until the next 15-min value is due (same rule as the apps,
 * currentExpiresAt), hourly series for 30 min. Exported for tests.
 */
export function openMeteoFreshUntil(elementJson: string, at: number): number | undefined {
  try {
    const e = JSON.parse(elementJson) as { current?: { time?: number; interval?: number }; hourly?: unknown }
    if (e.current) return currentExpiresAt(e.current, at)
    if (e.hourly) return at + HOURLY_FRESH_MS
  } catch { /* fall back to spec.freshMs */ }
  return undefined
}

export interface ProxyState {
  cache: Map<string, CacheEntry>
  cacheBytes: number
  inflight: Map<string, Promise<Upstream>>
  /** Per-location fetches in progress (perLocation specs): element JSON or null. */
  inflightLoc: Map<string, Promise<string | null>>
  userMisses: Map<string, number[]>
  upstreamCalls: number[]
  /** Upstream calls caused by requests without a session (last 24 h). */
  anonUpstreamCalls: number[]
  pausedUntil: number
  consecutiveThrottles: number
  nextSlotAt: number
}

export function newProxyState(): ProxyState {
  return { cache: new Map(), cacheBytes: 0, inflight: new Map(), inflightLoc: new Map(), userMisses: new Map(), upstreamCalls: [], anonUpstreamCalls: [], pausedUntil: 0, consecutiveThrottles: 0, nextSlotAt: 0 }
}

type Upstream =
  | { kind: 'ok'; body: string }
  | { kind: 'client-error'; status: number; body: string }
  | { kind: 'unavailable'; retryAfterS: number }

/** Normalised cache key: endpoint + allowed params in a fixed order. */
export function cacheKey(spec: ProxySpec, endpoint: string, q: URLSearchParams): string {
  const allowed = spec.endpoints[endpoint]
  const parts = (allowed ?? []).filter((k) => q.has(k)).map((k) => `${k}=${q.get(k)}`)
  return `${endpoint}?${parts.join('&')}`
}

function pruneWindow(ts: number[], now: number, win: number): number[] {
  let i = 0
  while (i < ts.length && now - ts[i]! >= win) i++
  return i ? ts.slice(i) : ts
}

function putCache(s: ProxyState, spec: ProxySpec, key: string, body: string, now: number, freshUntil?: number): void {
  const old = s.cache.get(key)
  if (old) { s.cacheBytes -= old.bytes; s.cache.delete(key) }
  const bytes = body.length * 2
  s.cache.set(key, { body, storedAt: now, bytes, freshUntil })
  s.cacheBytes += bytes
  // Map iterates in insertion order: drop the oldest until under budget.
  for (const [k, v] of s.cache) {
    if (s.cacheBytes <= spec.maxCacheBytes) break
    s.cache.delete(k)
    s.cacheBytes -= v.bytes
  }
}

/** Seconds until an upstream call of `weight` fits the budgets (0 = now). Exported for tests. */
export function upstreamWaitS(s: ProxyState, spec: ProxySpec, now: number, weight = 1): number {
  s.upstreamCalls = pruneWindow(s.upstreamCalls, now, DAY_MS)
  const calls = s.upstreamCalls
  const waits: number[] = [Math.max(0, s.pausedUntil - now)]
  const windows: [number, number][] = [[MINUTE_MS, spec.upstream.perMinute], [HOUR_MS, spec.upstream.hourly], [DAY_MS, spec.upstream.daily]]
  for (const [win, max] of windows) {
    const inWin = calls.filter((t) => now - t < win)
    if (weight > max) { waits.push(win); continue }
    // Entries are unit calls (a weighted call is pushed `weight` times).
    if (inWin.length + weight > max) waits.push(inWin[inWin.length + weight - max - 1]! + win - now)
  }
  return Math.ceil(Math.max(...waits) / 1000)
}

async function callUpstream(s: ProxyState, spec: ProxySpec, url: string, weight: number, now: () => number): Promise<Upstream> {
  // Spacing (OpenTopoData: 1 call/s): take the next free slot, but don't
  // queue a request for long -- the apps fall back (DEM) or retry later.
  const slot = Math.max(now(), s.nextSlotAt)
  if (slot - now() > MAX_QUEUE_MS) return { kind: 'unavailable', retryAfterS: Math.ceil((slot - now()) / 1000) }
  s.nextSlotAt = slot + spec.upstream.minIntervalMs
  if (slot > now()) await new Promise((r) => setTimeout(r, slot - now()))
  const wait = upstreamWaitS(s, spec, now(), weight)
  if (wait > 0) return { kind: 'unavailable', retryAfterS: wait }
  for (let i = 0; i < weight; i++) s.upstreamCalls.push(now())
  let res: Response
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'open-vfr/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(spec.timeoutMs) })
  } catch (err) {
    console.error(`[${spec.name}] upstream fetch failed:`, (err as Error)?.name, (err as Error)?.message)
    return { kind: 'unavailable', retryAfterS: 10 }
  }
  const body = await res.text().catch(() => '')
  if (res.ok) {
    s.consecutiveThrottles = 0
    return { kind: 'ok', body }
  }
  if (res.status === 429 || res.status === 503) {
    let reason = ''
    try {
      const j = JSON.parse(body) as { reason?: unknown; error?: unknown }
      reason = String(j.reason ?? j.error ?? '')
    } catch { /* not JSON */ }
    const delay = throttleDelayMs(s.consecutiveThrottles++, res.headers.get('Retry-After'), reason, now(), Math.random())
    s.pausedUntil = Math.max(s.pausedUntil, now() + delay)
    console.warn(`[${spec.name}] upstream ${res.status} (${reason.slice(0, 120)}): pausing ${Math.round(delay / 1000)} s`)
    return { kind: 'unavailable', retryAfterS: Math.ceil(delay / 1000) }
  }
  if (res.status >= 500) {
    console.error(`[${spec.name}] upstream HTTP ${res.status}: ${body.slice(0, 200)}`)
    return { kind: 'unavailable', retryAfterS: 10 }
  }
  // 4xx other than 429: the request itself is wrong; pass it through.
  return { kind: 'client-error', status: res.status, body }
}

/** Per-user miss quota. Returns seconds to wait, or 0 (and records the miss). Exported for tests. */
export function takeUserMiss(s: ProxyState, spec: ProxySpec, userId: string, now: number, limits = spec.perUser, weight = 1): number {
  const ts = pruneWindow(s.userMisses.get(userId) ?? [], now, DAY_MS)
  const lastHour = ts.filter((t) => now - t < HOUR_MS)
  if (lastHour.length + weight > limits.hourly) { s.userMisses.set(userId, ts); return Math.ceil(((lastHour[0] ?? now) + HOUR_MS - now) / 1000) }
  if (ts.length + weight > limits.daily) { s.userMisses.set(userId, ts); return Math.ceil(((ts[0] ?? now) + DAY_MS - now) / 1000) }
  for (let i = 0; i < weight; i++) ts.push(now)
  s.userMisses.set(userId, ts)
  return 0
}

function json(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra } })
}

function unavailable(spec: ProxySpec, retryAfterS: number, why: string): Response {
  const s = Math.max(1, Math.min(MAX_PAUSE_REPORT_S, retryAfterS))
  return json(JSON.stringify({ error: true, reason: `${spec.name} temporarily unavailable: ${why}` }), 503, { 'Retry-After': String(s), 'Cache-Control': 'no-store' })
}

/** Who is asking: a signed-in user, or (transition mode) an anonymous client IP. */
export type Caller = { kind: 'user'; id: string } | { kind: 'anonymous'; ip: string }

/** Charge `weight` upstream calls to the caller's caps; seconds to wait, or 0 (charged). */
function chargeCaller(s: ProxyState, spec: ProxySpec, caller: Caller, t: number, weight: number): number {
  let wait = caller.kind === 'user'
    ? takeUserMiss(s, spec, caller.id, t, spec.perUser, weight)
    : takeUserMiss(s, spec, `anon:${caller.ip}`, t, { hourly: spec.anonymous.perIpHourly, daily: spec.anonymous.perIpDaily }, weight)
  if (!wait && caller.kind === 'anonymous') {
    s.anonUpstreamCalls = pruneWindow(s.anonUpstreamCalls, t, DAY_MS)
    if (s.anonUpstreamCalls.length + weight > spec.anonymous.upstreamDaily) wait = Math.ceil(((s.anonUpstreamCalls[0] ?? t) + DAY_MS - t) / 1000)
    else for (let i = 0; i < weight; i++) s.anonUpstreamCalls.push(t)
  }
  return wait
}

function limitReached(spec: ProxySpec, caller: Caller, waitS: number): Response {
  const why = caller.kind === 'anonymous' ? `Request limit reached for ${spec.name}; sign in for more` : `Request limit reached for ${spec.name}`
  return json(JSON.stringify({ error: true, reason: why }), 429, { 'Retry-After': String(Math.min(MAX_PAUSE_REPORT_S, waitS)), 'Cache-Control': 'no-store' })
}

/**
 * Multi-location request (Open-Meteo): cached, fetched and shared PER
 * LOCATION, not per URL. Clients only ask for the points they lack, so two
 * users looking at the same map area rarely send the same URL -- but the
 * points themselves (world-anchored wind-grid lattice, 0.05 deg snapped
 * route samples) are the same. Each location is served from the cache when
 * fresh, awaited when another request is already fetching it, and only the
 * rest go upstream in one batched request (costed for those alone). The
 * answer keeps Open-Meteo's shape: an object for one location, else an
 * array in request order. If any location can't be served (not even
 * stale), the whole request gets 429/503 -- the apps fall back to their own
 * last good values and retry later, now with the rest cached here.
 */
async function handlePerLocation(
  spec: ProxySpec, s: ProxyState, caller: Caller, endpoint: string, q: URLSearchParams, now: () => number,
): Promise<Response> {
  const lats = q.get('latitude')!.split(','), lngs = q.get('longitude')!.split(',')
  const rest = new URLSearchParams()
  for (const k of spec.endpoints[endpoint] ?? []) {
    if (k !== 'latitude' && k !== 'longitude' && q.has(k)) rest.set(k, q.get(k)!)
  }
  const base = `${endpoint}?${rest.toString()}`
  const locs = lats.map((la, i) => ({ la, lo: lngs[i]!, key: `${base}@${la},${lngs[i]}` }))
  const t = now()
  const fresh = new Map<string, string>()
  const stale = new Map<string, string>()
  const waiting: Promise<void>[] = []
  const toFetch: typeof locs = []
  const seen = new Set<string>()
  for (const l of locs) {
    if (seen.has(l.key)) continue
    seen.add(l.key)
    const hit = s.cache.get(l.key)
    if (hit && isFresh(hit, spec, t)) { fresh.set(l.key, hit.body); continue }
    if (hit && isUsableStale(hit, spec, t)) stale.set(l.key, hit.body)
    const pend = s.inflightLoc.get(l.key)
    if (pend) { waiting.push(pend.then((b) => { if (b) fresh.set(l.key, b) })); continue }
    toFetch.push(l)
  }

  let outcome: Upstream | { kind: 'limit'; waitS: number } | null = null
  if (toFetch.length > 0) {
    const fq = new URLSearchParams()
    fq.set('latitude', toFetch.map((l) => l.la).join(','))
    fq.set('longitude', toFetch.map((l) => l.lo).join(','))
    for (const [k, v] of rest) fq.set(k, v)
    const weight = spec.weight(endpoint, fq)
    const waitS = chargeCaller(s, spec, caller, t, weight)
    if (waitS > 0) {
      outcome = { kind: 'limit', waitS }
    } else {
      const url = `${spec.upstreamBase}${endpoint}?${decodeURIComponent(fq.toString())}`
      const call = callUpstream(s, spec, url, weight, now).then((r) => {
        if (r.kind !== 'ok') return { r, els: null as string[] | null }
        let els: string[] | null = null
        try {
          const parsed: unknown = JSON.parse(r.body)
          const list = Array.isArray(parsed) ? parsed : [parsed]
          if (list.length === toFetch.length) els = list.map((e) => JSON.stringify(e))
        } catch { /* fall through */ }
        if (!els) {
          console.error(`[${spec.name}] unexpected upstream body for ${toFetch.length} location(s): ${r.body.slice(0, 200)}`)
          return { r: { kind: 'unavailable', retryAfterS: 30 } as Upstream, els: null }
        }
        const at = now()
        els.forEach((e, i) => putCache(s, spec, toFetch[i]!.key, e, at, openMeteoFreshUntil(e, at)))
        return { r, els }
      })
      toFetch.forEach((l, i) => {
        const p = call.then((c) => c.els?.[i] ?? null).catch(() => null).finally(() => {
          if (s.inflightLoc.get(l.key) === p) s.inflightLoc.delete(l.key)
        })
        s.inflightLoc.set(l.key, p)
      })
      const c = await call.catch(() => ({ r: { kind: 'unavailable', retryAfterS: 10 } as Upstream, els: null }))
      outcome = c.r
      c.els?.forEach((e, i) => fresh.set(toFetch[i]!.key, e))
    }
  }
  await Promise.all(waiting)

  const parts: string[] = []
  let usedStale = false
  for (const l of locs) {
    const b = fresh.get(l.key) ?? stale.get(l.key)
    if (!b) {
      if (outcome?.kind === 'limit') return limitReached(spec, caller, outcome.waitS)
      if (outcome?.kind === 'client-error') return json(outcome.body || JSON.stringify({ error: true, reason: 'Upstream rejected the request' }), outcome.status)
      return unavailable(spec, outcome && outcome.kind === 'unavailable' ? outcome.retryAfterS : 10, 'upstream busy')
    }
    if (!fresh.has(l.key)) usedStale = true
    parts.push(b)
  }
  const body = lats.length === 1 ? parts[0]! : `[${parts.join(',')}]`
  if (usedStale) return json(body, 200, { 'Cache-Control': 'no-store', 'X-Cache': 'STALE' })
  return json(body, 200, {
    'Cache-Control': `private, max-age=${Math.round(spec.freshMs / 1000)}`,
    'X-Cache': toFetch.length === 0 && waiting.length === 0 ? 'HIT' : 'MISS',
  })
}

/**
 * Handle one proxied request. `path` is the request path, `search` its raw
 * query string. A bare string caller is a user id (tests, convenience).
 */
export async function handleProxy(
  spec: ProxySpec, s: ProxyState, callerOrUserId: Caller | string, path: string, search: string,
  now: () => number = Date.now,
): Promise<Response> {
  const caller: Caller = typeof callerOrUserId === 'string' ? { kind: 'user', id: callerOrUserId } : callerOrUserId
  const endpoint = path.slice(spec.prefix.length)
  const allowed = spec.endpoints[endpoint]
  if (!allowed) return json(JSON.stringify({ error: true, reason: 'Unknown endpoint' }), 404)
  const q = new URLSearchParams(search)
  for (const k of q.keys()) {
    if (!allowed.includes(k)) return json(JSON.stringify({ error: true, reason: `Parameter not allowed: ${k}` }), 400)
  }
  const invalid = spec.validate(endpoint, q)
  if (invalid) return json(JSON.stringify({ error: true, reason: invalid }), 400)
  if (spec.perLocation) return handlePerLocation(spec, s, caller, endpoint, q, now)

  const key = cacheKey(spec, endpoint, q)
  const t = now()
  const hit = s.cache.get(key)
  const cacheControl = `private, max-age=${Math.round(spec.freshMs / 1000)}`
  if (hit && isFresh(hit, spec, t)) return json(hit.body, 200, { 'Cache-Control': cacheControl, 'X-Cache': 'HIT' })
  const stale = hit && isUsableStale(hit, spec, t) ? hit : undefined

  let pending = s.inflight.get(key)
  if (!pending) {
    const weight = spec.weight(endpoint, q)
    const userWait = chargeCaller(s, spec, caller, t, weight)
    if (userWait > 0) {
      if (stale) return json(stale.body, 200, { 'Cache-Control': 'no-store', 'X-Cache': 'STALE' })
      return limitReached(spec, caller, userWait)
    }
    const url = `${spec.upstreamBase}${endpoint}?${key.slice(endpoint.length + 1)}`
    pending = callUpstream(s, spec, url, weight, now).then((r) => {
      if (r.kind === 'ok') putCache(s, spec, key, r.body, now())
      return r
    }).finally(() => s.inflight.delete(key))
    s.inflight.set(key, pending)
  }
  const r = await pending
  if (r.kind === 'ok') return json(r.body, 200, { 'Cache-Control': cacheControl, 'X-Cache': 'MISS' })
  if (r.kind === 'client-error') return json(r.body || JSON.stringify({ error: true, reason: 'Upstream rejected the request' }), r.status)
  if (stale) return json(stale.body, 200, { 'Cache-Control': 'no-store', 'X-Cache': 'STALE' })
  return unavailable(spec, r.retryAfterS, 'upstream busy')
}

/**
 * Requests without a session. 'limited' (default): served with the tight
 * per-IP caps and capped share of the upstream budget in spec.anonymous --
 * a TRANSITION mode, because app builds from before this proxy existed
 * (installed native apps, open web tabs) send no session on these paths.
 * 'off': 401, the end state once those builds are gone.
 * Env: EXTERNAL_PROXY_ANONYMOUS=limited|off.
 */
export function anonymousModeFromEnv(v: string | undefined): 'limited' | 'off' {
  return (v ?? '').trim().toLowerCase() === 'off' ? 'off' : 'limited'
}

/** Mounts both proxies on the Hono app. */
export function mountExternalProxies(
  app: { get: (path: string, h: (c: Context) => Promise<Response> | Response) => unknown },
  requireSession: (c: Context) => Promise<{ id: string } | null>,
  anonymousMode: 'limited' | 'off' = anonymousModeFromEnv(process.env['EXTERNAL_PROXY_ANONYMOUS']),
): void {
  console.log(`[external-proxy] requests without a session: ${anonymousMode}`)
  for (const spec of [OPEN_METEO, ELEVATION]) {
    const state = newProxyState()
    const stats = newUsageStats(Date.now())
    registry.push({ spec, state, stats, anonymousMode })
    app.get(`${spec.prefix}*`, async (c) => {
      rotateHour(spec, state, stats, Date.now())
      const user = await requireSession(c)
      const url = new URL(c.req.url)
      let res: Response
      if (user) {
        res = await handleProxy(spec, state, { kind: 'user', id: user.id }, url.pathname, url.search)
        stats.users.add(user.id)
      } else if (anonymousMode === 'off') {
        return c.json({ error: 'Authentication required.' }, 401)
      } else {
        // Same trusted client-IP headers as better-auth (auth.ts): set by
        // Cloudflare / the reverse proxy, never X-Forwarded-For.
        const ip = c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || 'unknown'
        res = await handleProxy(spec, state, { kind: 'anonymous', ip }, url.pathname, url.search)
        stats.anonymousIps.add(ip)
      }
      countResponse(stats, res)
      return res
    })
    // Closes each clock hour: one log line + a snapshot for the admin UI,
    // even when no request arrives to trigger it.
    setInterval(() => rotateHour(spec, state, stats, Date.now()), MINUTE_MS).unref?.()
  }
}

interface UsageStats {
  /** Start of the clock hour being counted. */
  hourStart: number
  byOutcome: Record<string, number>
  users: Set<string>
  anonymousIps: Set<string>
  /** Closed hours, oldest first, at most HISTORY_HOURS. */
  history: HourSnapshot[]
}

/** One closed clock hour (counts only, no ids). */
export interface HourSnapshot {
  hourStart: string
  outcomes: Record<string, number>
  users: number
  anonymousIps: number
  /** Weighted upstream calls made in that hour. */
  upstreamCalls: number
}

const HISTORY_HOURS = 48
const hourOf = (t: number) => t - (t % HOUR_MS)

function newUsageStats(now: number): UsageStats {
  return { hourStart: hourOf(now), byOutcome: {}, users: new Set(), anonymousIps: new Set(), history: [] }
}

/** Close the counted hour if the clock has moved on. Exported for tests. */
export function rotateHour(spec: ProxySpec, s: ProxyState, stats: UsageStats, now: number, log = true): void {
  if (hourOf(now) === stats.hourStart) return
  const end = stats.hourStart + HOUR_MS
  s.upstreamCalls = pruneWindow(s.upstreamCalls, now, DAY_MS)
  stats.history.push({
    hourStart: new Date(stats.hourStart).toISOString(),
    outcomes: stats.byOutcome,
    users: stats.users.size,
    anonymousIps: stats.anonymousIps.size,
    upstreamCalls: s.upstreamCalls.filter((t) => t >= stats.hourStart && t < end).length,
  })
  if (stats.history.length > HISTORY_HOURS) stats.history.splice(0, stats.history.length - HISTORY_HOURS)
  // Hourly usage line, to size the plan from real numbers (no user ids or IPs logged).
  if (log) console.log(usageLine(spec, s, stats, end))
  stats.hourStart = hourOf(now)
  stats.byOutcome = {}
  stats.users = new Set()
  stats.anonymousIps = new Set()
}

const registry: { spec: ProxySpec; state: ProxyState; stats: UsageStats; anonymousMode: 'limited' | 'off' }[] = []
const processStartedAt = new Date().toISOString()

/** Aggregate usage of one relay for the admin API (counts only, no ids). */
export interface ExternalApiUsage {
  name: string
  anonymousMode: 'limited' | 'off'
  /** Counters are in memory: they start empty when the api (re)starts. */
  since: string
  budget: { perMinute: number; hourly: number; daily: number }
  upstream: { lastMinute: number; lastHour: number; last24h: number }
  anonymous: { last24h: number; dailyCap: number }
  perUserCap: { hourly: number; daily: number }
  pausedUntil: string | null
  cache: { entries: number; bytes: number }
  currentHour: Omit<HourSnapshot, 'upstreamCalls'> & { upstreamCalls: number }
  /** Closed clock hours, oldest first (up to 48). */
  hours: HourSnapshot[]
}

export function usageSnapshot(spec: ProxySpec, s: ProxyState, stats: UsageStats, anonymousMode: 'limited' | 'off', now: number): ExternalApiUsage {
  rotateHour(spec, s, stats, now)
  const calls = s.upstreamCalls
  const count = (win: number) => calls.filter((t) => now - t < win).length
  return {
    name: spec.name,
    anonymousMode,
    since: processStartedAt,
    budget: { perMinute: spec.upstream.perMinute, hourly: spec.upstream.hourly, daily: spec.upstream.daily },
    upstream: { lastMinute: count(MINUTE_MS), lastHour: count(HOUR_MS), last24h: count(DAY_MS) },
    anonymous: { last24h: s.anonUpstreamCalls.filter((t) => now - t < DAY_MS).length, dailyCap: spec.anonymous.upstreamDaily },
    perUserCap: { ...spec.perUser },
    pausedUntil: s.pausedUntil > now ? new Date(s.pausedUntil).toISOString() : null,
    cache: { entries: s.cache.size, bytes: s.cacheBytes },
    currentHour: {
      hourStart: new Date(stats.hourStart).toISOString(),
      outcomes: { ...stats.byOutcome },
      users: stats.users.size,
      anonymousIps: stats.anonymousIps.size,
      upstreamCalls: calls.filter((t) => t >= stats.hourStart).length,
    },
    hours: [...stats.history],
  }
}

/** Usage of every mounted relay (GET /api/admin/external-apis). */
export function externalApiUsage(now = Date.now()): ExternalApiUsage[] {
  return registry.map((r) => usageSnapshot(r.spec, r.state, r.stats, r.anonymousMode, now))
}

function countResponse(stats: UsageStats, res: Response): void {
  const k = res.status === 200 ? (res.headers.get('X-Cache') ?? 'OK') : String(res.status)
  stats.byOutcome[k] = (stats.byOutcome[k] ?? 0) + 1
}

/** One summary line for the last hour, then reset. Exported for tests. */
export function usageLine(spec: ProxySpec, s: ProxyState, stats: UsageStats, now: number): string {
  const calls = s.upstreamCalls
  const lastHour = calls.filter((t) => now - t < HOUR_MS).length
  const lastDay = calls.filter((t) => now - t < DAY_MS).length
  const outcomes = Object.entries(stats.byOutcome).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'
  return `[${spec.name}] last hour: requests ${outcomes}; users ${stats.users.size}, anonymous IPs ${stats.anonymousIps.size}; ` +
    `upstream calls (weighted) hour ${lastHour}/${spec.upstream.hourly}, 24 h ${lastDay}/${spec.upstream.daily}; ` +
    `cache ${s.cache.size} entries, ${Math.round(s.cacheBytes / 1024)} KiB`
}


