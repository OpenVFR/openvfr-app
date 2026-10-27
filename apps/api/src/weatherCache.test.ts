import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWeatherCache, type WxUpstreamResult } from './weatherCache'

function setup(opts: { fail?: boolean } = {}) {
  let t = 1_000_000
  const calls: string[] = []
  const logs: string[] = []
  const levels: string[] = []
  let mode: 'ok' | 'fail' | 'partial' = opts.fail ? 'fail' : 'ok'
  let n = 0
  const cache = createWeatherCache({
    now: () => t,
    log: (l, level) => { logs.push(l); levels.push(level) },
    fetchUpstream: async (icao): Promise<WxUpstreamResult> => {
      calls.push(icao)
      n++
      if (mode === 'fail') { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e }
      if (mode === 'partial') return { data: { metar: null, taf: `TAF ${n}` }, failed: ['metar'], reason: 'upstream HTTP metar=502 taf=200' }
      return { data: { metar: `METAR ${n}`, taf: `TAF ${n}` }, failed: [] }
    },
  })
  return {
    cache, calls, logs, levels,
    advance: (ms: number) => { t += ms },
    setMode: (m: typeof mode) => { mode = m },
  }
}

const allow = () => true

test('fresh hit within 5 min, refetch after', async () => {
  const s = setup()
  const a = await s.cache.get('ESSA', allow)
  assert.deepEqual(a, { kind: 'ok', data: { metar: 'METAR 1', taf: 'TAF 1' }, stale: false })
  s.advance(4 * 60_000)
  await s.cache.get('ESSA', allow)
  assert.equal(s.calls.length, 1)
  s.advance(2 * 60_000)
  const b = await s.cache.get('ESSA', allow)
  assert.equal(s.calls.length, 2)
  assert.equal(b.kind === 'ok' && b.data.metar, 'METAR 2')
})

test('concurrent misses share one upstream call', async () => {
  const s = setup()
  await Promise.all([s.cache.get('ESSA', allow), s.cache.get('ESSA', allow), s.cache.get('ESSA', allow)])
  assert.equal(s.calls.length, 1)
})

test('upstream failure serves the last good report and backs off', async () => {
  const s = setup()
  await s.cache.get('ESSA', allow)
  s.advance(6 * 60_000)
  s.setMode('fail')
  const a = await s.cache.get('ESSA', allow)
  assert.deepEqual(a, { kind: 'ok', data: { metar: 'METAR 1', taf: 'TAF 1' }, stale: true })
  assert.equal(s.calls.length, 2)
  // Within the backoff: no new upstream call, still the old report.
  s.advance(30_000)
  const b = await s.cache.get('ESSA', allow)
  assert.equal(b.kind, 'ok')
  assert.equal(s.calls.length, 2)
  // After the backoff upstream is tried again; recovered = fresh data.
  s.advance(31_000)
  s.setMode('ok')
  const c = await s.cache.get('ESSA', allow)
  assert.deepEqual(c, { kind: 'ok', data: { metar: 'METAR 3', taf: 'TAF 3' }, stale: false })
})

test('no cached report: unavailable, and no upstream call during the backoff', async () => {
  const s = setup({ fail: true })
  assert.deepEqual(await s.cache.get('ESGG', allow), { kind: 'unavailable' })
  assert.deepEqual(await s.cache.get('ESGG', allow), { kind: 'unavailable' })
  assert.equal(s.calls.length, 1)
})

test('a report older than 90 min is not served', async () => {
  const s = setup()
  await s.cache.get('ESSA', allow)
  s.advance(91 * 60_000)
  s.setMode('fail')
  assert.deepEqual(await s.cache.get('ESSA', allow), { kind: 'unavailable' })
})

test('partial failure fills the failed part from the last good report, not cached', async () => {
  const s = setup()
  await s.cache.get('ESSA', allow)
  s.advance(6 * 60_000)
  s.setMode('partial')
  const a = await s.cache.get('ESSA', allow)
  assert.deepEqual(a, { kind: 'ok', data: { metar: 'METAR 1', taf: 'TAF 2' }, stale: false })
  s.advance(61_000)
  s.setMode('ok')
  await s.cache.get('ESSA', allow)
  assert.equal(s.calls.length, 3)
})

test('miss limiter is only asked for new upstream calls', async () => {
  const s = setup()
  let asked = 0
  const limiter = () => { asked++; return true }
  await s.cache.get('ESSA', limiter)
  await s.cache.get('ESSA', limiter)
  assert.equal(asked, 1)
  const denied = await s.cache.get('ESGG', () => false)
  assert.deepEqual(denied, { kind: 'limited' })
  assert.equal(s.calls.length, 1)
})

test('failures are logged as one summary line per minute', async () => {
  const s = setup({ fail: true })
  for (const icao of ['ESSA', 'ESGG', 'ESSB', 'ESOW']) await s.cache.get(icao, allow)
  assert.equal(s.logs.length, 0)
  s.advance(61_000)
  await s.cache.get('ESMS', allow)
  assert.equal(s.logs.length, 1)
  assert.match(s.logs[0]!, /upstream failed 4x for 4 station\(s\)/)
  assert.match(s.logs[0]!, /TimeoutError x4/)
  // A handful of failures is not an outage: info, not an error line.
  assert.equal(s.levels[0], 'info')
})

test('an upstream that is mostly down is logged as an error', async () => {
  const s = setup({ fail: true })
  for (const icao of ['ESSA', 'ESGG', 'ESSB', 'ESOW', 'ESMS', 'ESNN']) await s.cache.get(icao, allow)
  s.advance(61_000)
  s.cache.flushLog()
  assert.equal(s.levels[0], 'error')
  assert.match(s.logs[0]!, /failed 6x .*answered 0x/)
})

test('failures among mostly answered calls stay info', async () => {
  const s = setup()
  for (const icao of ['ESSA', 'ESGG', 'ESSB']) await s.cache.get(icao, allow)
  s.setMode('fail')
  for (const icao of ['ESOW', 'ESMS', 'ESNN', 'ESDF', 'ESMK']) await s.cache.get(icao, allow)
  s.setMode('ok')
  for (const icao of ['ESGT', 'ESGP', 'ESMQ', 'ESMX', 'ESOK', 'ESND']) await s.cache.get(icao, allow)
  s.cache.flushLog()
  // Answered calls count across the whole window, before the failures too.
  assert.match(s.logs[0]!, /failed 5x .*answered 9x/)
  assert.equal(s.levels[0], 'info')
})

test('failures at the end of a mostly answered window stay info', async () => {
  const s = setup()
  for (const icao of ['ESSA', 'ESGG', 'ESSB', 'ESOW', 'ESMS', 'ESNN']) await s.cache.get(icao, allow)
  s.setMode('fail')
  for (const icao of ['ESDF', 'ESMK', 'ESGT', 'ESGP', 'ESMQ']) await s.cache.get(icao, allow)
  s.cache.flushLog()
  assert.match(s.logs[0]!, /failed 5x .*answered 6x/)
  assert.equal(s.levels[0], 'info')
})

test('a window with only answered calls logs nothing', async () => {
  const s = setup()
  await s.cache.get('ESSA', allow)
  s.advance(61_000)
  await s.cache.get('ESGG', allow)
  s.cache.flushLog()
  assert.equal(s.logs.length, 0)
})
