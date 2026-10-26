/**
 * Cache in front of the METAR/TAF upstream (aviationweather.gov) for
 * GET /api/weather.
 *
 * - Fresh for `ttlMs` (5 min): served without an upstream call.
 * - Identical concurrent misses share one upstream call.
 * - Upstream failure (timeout, 5xx):
 *   - the last good report is served if it is younger than `staleMaxMs`
 *     (METARs are issued about every 30-60 min, a report a few minutes past
 *     its cache time beats an error in the cockpit);
 *   - the station is not asked again for `failBackoffMs`. Every client
 *     request used to go upstream again during an outage, wait for the
 *     timeout and log an error, which turned one slow upstream into a burst of
 *     timeouts and error lines.
 * - Failures are logged as one summary line per `logWindowMs` instead of one
 *   line per request. The line is an error only when the upstream is mostly
 *   down (at least `errorMinFailures` failed calls in the window, and more
 *   failed than answered); the odd timeout or 502, mostly bridged by the
 *   cache, is logged as info. The production log watcher alerts on every
 *   error line (stderr), and a single slow METAR is not worth a page.
 *
 * No I/O of its own: the upstream fetch, clock and logger are injected, so the
 * behaviour is unit-tested (weatherCache.test.ts).
 */

export type WxData = { metar: string | null; taf: string | null }

/**
 * Result of one upstream fetch. `failed` lists the parts whose upstream call
 * failed (the other part still answered): such a result is served, with the
 * failed part taken from the last good report when there is one, but not cached.
 */
export type WxUpstreamResult = { data: WxData; failed: ('metar' | 'taf')[]; reason?: string }

export type WxLookup =
  | { kind: 'ok'; data: WxData; stale: boolean }
  | { kind: 'limited' }
  | { kind: 'unavailable' }

export interface WeatherCacheOptions {
  fetchUpstream: (icao: string) => Promise<WxUpstreamResult>
  now?: () => number
  ttlMs?: number
  staleMaxMs?: number
  failBackoffMs?: number
  maxEntries?: number
  logWindowMs?: number
  /** Failed calls in one window from which a mostly-failing upstream is logged as an error. */
  errorMinFailures?: number
  log?: (line: string, level: 'info' | 'error') => void
}

export function createWeatherCache(opts: WeatherCacheOptions) {
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? 5 * 60_000
  const staleMaxMs = opts.staleMaxMs ?? 90 * 60_000
  const failBackoffMs = opts.failBackoffMs ?? 60_000
  const maxEntries = opts.maxEntries ?? 5000
  const logWindowMs = opts.logWindowMs ?? 60_000
  const errorMinFailures = opts.errorMinFailures ?? 5
  // stdout for info, stderr only for real outages (see the header).
  const log = opts.log ?? ((line: string, level: 'info' | 'error') => (level === 'error' ? console.error(line) : console.log(line)))

  const cache = new Map<string, { data: WxData; fetchedAt: number }>()
  const failedUntil = new Map<string, number>()
  const inflight = new Map<string, Promise<WxUpstreamResult>>()

  // Failure summary for the current log window.
  let windowStart = 0
  let failures = 0
  let successes = 0
  let staleServed = 0
  const reasons = new Map<string, number>()
  const stations = new Set<string>()

  function noteFailure(icao: string, reason: string, servedStale: boolean) {
    const t = now()
    if (failures === 0) { windowStart = t; successes = 0 }
    failures++
    if (servedStale) staleServed++
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
    stations.add(icao)
    flushLog(false)
  }

  /** Writes the summary once the window is over (or `force`). */
  function flushLog(force: boolean) {
    if (failures === 0) return
    if (!force && now() - windowStart < logWindowMs) return
    const why = [...reasons.entries()].map(([r, n]) => `${r} x${n}`).join(', ')
    const level = failures >= errorMinFailures && failures > successes ? 'error' : 'info'
    log(`[weather] upstream failed ${failures}x for ${stations.size} station(s), answered ${successes}x, in the last ${Math.round((now() - windowStart) / 1000)} s (${why}); ${staleServed} answered from older cached reports`, level)
    failures = 0; successes = 0; staleServed = 0; reasons.clear(); stations.clear()
  }

  function remember(icao: string, data: WxData) {
    cache.delete(icao)
    cache.set(icao, { data, fetchedAt: now() })
    // Map iterates in insertion order: drop the oldest beyond the cap.
    for (const k of cache.keys()) {
      if (cache.size <= maxEntries) break
      cache.delete(k)
    }
  }

  function staleFor(icao: string): WxData | null {
    const c = cache.get(icao)
    return c && now() - c.fetchedAt < staleMaxMs ? c.data : null
  }

  /**
   * Look up `icao`. `allowMiss` is asked before a new upstream call (the
   * per-user miss limiter); it is not asked for cache hits, shared in-flight
   * calls or stations in failure backoff.
   */
  async function get(icao: string, allowMiss: () => boolean): Promise<WxLookup> {
    flushLog(false)
    const c = cache.get(icao)
    if (c && now() - c.fetchedAt < ttlMs) return { kind: 'ok', data: c.data, stale: false }

    let pending = inflight.get(icao)
    if (!pending) {
      if ((failedUntil.get(icao) ?? 0) > now()) {
        const stale = staleFor(icao)
        return stale ? { kind: 'ok', data: stale, stale: true } : { kind: 'unavailable' }
      }
      if (!allowMiss()) return { kind: 'limited' }
      pending = opts.fetchUpstream(icao).then((r) => {
        if (r.failed.length === 0) {
          successes++
          failedUntil.delete(icao)
          remember(icao, r.data)
          return r
        }
        // Partly failed: fill the failed part from the last good report.
        failedUntil.set(icao, now() + failBackoffMs)
        const stale = staleFor(icao)
        noteFailure(icao, r.reason ?? `upstream ${r.failed.join('+')} failed`, stale != null)
        if (!stale) return r
        return {
          ...r,
          data: {
            metar: r.failed.includes('metar') ? stale.metar : r.data.metar,
            taf:   r.failed.includes('taf')   ? stale.taf   : r.data.taf,
          },
        }
      }).finally(() => inflight.delete(icao))
      inflight.set(icao, pending)
      // A failed shared call is handled once, here (each waiter only reads the outcome).
      pending.catch((err: unknown) => {
        failedUntil.set(icao, now() + failBackoffMs)
        const e = err as Error | undefined
        noteFailure(icao, e?.name === 'Error' ? (e?.message ?? 'Error') : (e?.name ?? 'unknown'), staleFor(icao) != null)
      })
    }
    try {
      const r = await pending
      return { kind: 'ok', data: r.data, stale: false }
    } catch {
      const stale = staleFor(icao)
      return stale ? { kind: 'ok', data: stale, stale: true } : { kind: 'unavailable' }
    }
  }

  return { get, flushLog: () => flushLog(true) }
}
