import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { PohGuards, pohGuardConfigFromEnv, countPdfPages, type PohGuardConfig } from './pohGuards.js'

const cfg = (over: Partial<PohGuardConfig> = {}): PohGuardConfig =>
  ({ hourlyPerUser: 3, dailyPerUser: 5, dailyGlobal: 50, maxConcurrent: 2, maxPages: 250, maxOutputTokens: 16000, ...over })
const T0 = Date.UTC(2026, 0, 1, 10)
const HOUR = 3600_000

// ── config ───────────────────────────────────────────────────────────────────
test('defaults: 5 a day and 3 an hour per user, 50 a day overall, 2 at once, 250 pages, 16000 output tokens', () => {
  assert.deepEqual(pohGuardConfigFromEnv({}), cfg())
})

test('an empty or invalid variable falls back to the default and never to 0', () => {
  const c = pohGuardConfigFromEnv({ POH_DAILY_LIMIT: '', POH_GLOBAL_DAILY_LIMIT: 'abc', POH_MAX_PAGES: '0', POH_MAX_CONCURRENT: '-1' })
  assert.equal(c.dailyPerUser, 5)
  assert.equal(c.dailyGlobal, 50)
  assert.equal(c.maxPages, 250)
  assert.equal(c.maxConcurrent, 2)
  assert.equal(pohGuardConfigFromEnv({ POH_DAILY_LIMIT: '8' }).dailyPerUser, 8)
})

// ── per user ─────────────────────────────────────────────────────────────────
test('the hourly limit stops the 4th extraction within an hour, the daily one the 6th within a day', () => {
  const g = new PohGuards(cfg())
  for (let i = 0; i < 3; i++) assert.equal(g.charge('u1', T0 + i * 1000).allowed, true)
  const hourly = g.charge('u1', T0 + 5000)
  assert.equal(hourly.allowed, false)
  assert.ok(!hourly.allowed && hourly.status === 429 && /Hourly limit of 3/.test(hourly.reason))
  // an hour later: 3 more would pass the hourly window, but only 2 are left of the 5 a day
  assert.equal(g.charge('u1', T0 + HOUR + 10_000).allowed, true)
  assert.equal(g.charge('u1', T0 + HOUR + 11_000).allowed, true)
  const daily = g.charge('u1', T0 + HOUR + 12_000)
  assert.ok(!daily.allowed && /Daily limit of 5/.test(daily.reason) && daily.retryAfterSeconds > 3600)
})

test('another user is not affected by one user\'s limit', () => {
  const g = new PohGuards(cfg())
  for (let i = 0; i < 3; i++) g.charge('u1', T0)
  assert.equal(g.charge('u1', T0).allowed, false)
  assert.equal(g.charge('u2', T0).allowed, true)
})

// ── all users ────────────────────────────────────────────────────────────────
test('the global daily limit stops everyone, however many accounts', () => {
  const g = new PohGuards(cfg({ dailyGlobal: 4 }))
  for (let i = 0; i < 4; i++) assert.equal(g.charge(`user${i}`, T0 + i).allowed, true)   // four different accounts, one each
  const r = g.charge('user-new', T0 + 10)
  assert.ok(!r.allowed && r.status === 429 && /daily capacity for all users/.test(r.reason))
  assert.equal(g.precheck('user-new', T0 + 11).allowed, false)
  // a day later the window has moved on
  assert.equal(g.charge('user-new', T0 + 25 * HOUR).allowed, true)
})

test('a refusal charges nobody: global-full does not use up the user\'s quota', () => {
  // One a day per user and one a day overall. b is refused by the global limit at +22h. If that refusal were charged to b,
  // b's own daily window would still hold it at +25h, when the global one has already freed up.
  const g = new PohGuards(cfg({ dailyPerUser: 1, dailyGlobal: 1 }))
  assert.equal(g.charge('a', T0).allowed, true)
  const refused = g.charge('b', T0 + 22 * HOUR)
  assert.ok(!refused.allowed && /all users/.test(refused.reason))
  assert.equal(g.charge('b', T0 + 25 * HOUR).allowed, true)
})

test('an extraction that the user limit refuses does not count against the global limit', () => {
  const g = new PohGuards(cfg({ hourlyPerUser: 1, dailyGlobal: 3 }))
  assert.equal(g.charge('a', T0).allowed, true)
  for (let i = 0; i < 5; i++) assert.equal(g.charge('a', T0 + 1 + i).allowed, false)
  assert.equal(g.charge('b', T0 + 10).allowed, true)
  assert.equal(g.charge('c', T0 + 11).allowed, true)     // 3rd global: only a, b, c were charged
})

// ── at once ──────────────────────────────────────────────────────────────────
test('at most maxConcurrent extractions run; a freed slot is reusable; releasing twice is harmless', () => {
  const g = new PohGuards(cfg({ maxConcurrent: 2 }))
  const a = g.tryAcquire(); const b = g.tryAcquire()
  assert.ok(a.allowed && b.allowed)
  const c = g.tryAcquire()
  assert.ok(!c.allowed && c.status === 503 && c.retryAfterSeconds === 30)
  assert.ok(!g.precheck('u', T0).allowed, 'the early check refuses too, before a 50 MB body is read')
  if (a.allowed) { a.release(); a.release() }
  assert.equal(g.inFlight, 1)
  assert.ok(g.tryAcquire().allowed)
  assert.equal(g.inFlight, 2)
})

// ── pages ────────────────────────────────────────────────────────────────────
const pdfBytes = (body: string) => new Uint8Array(Buffer.from(`%PDF-1.4\n${body}\n%%EOF`, 'latin1'))

test('counts the page objects of a plain PDF', () => {
  const body = ['<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
    '<< /Type /Page /Parent 2 0 R >>', '<< /Type /Page /Parent 2 0 R >>', '<< /Type /Page /Parent 2 0 R >>'].join('\nendobj\n')
  assert.equal(countPdfPages(pdfBytes(body)), 3)
})

test('does not confuse /Pages or /PageLabels with a page, and ignores outline /Count values', () => {
  const body = ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R >>',
    '<< /Type /PageLabels >>', '<< /Title (Chapter) /Count 40 /First 9 0 R >>'].join('\nendobj\n')
  assert.equal(countPdfPages(pdfBytes(body)), 1)
})

test('reads the page tree count out of a compressed object stream (the usual layout of Word and Acrobat PDFs)', () => {
  const objects = '<< /Type /Pages /Kids [10 0 R] /Count 180 /Parent null >> << /Type /Catalog /Pages 1 0 R >>'
  const z = deflateSync(Buffer.from(`1 0 2 ${objects.length}\n${objects}`, 'latin1'))
  const pdf = Buffer.concat([
    Buffer.from(`%PDF-1.5\n5 0 obj\n<< /Type /ObjStm /N 2 /First 8 /Filter /FlateDecode /Length ${z.length} >>\nstream\n`, 'latin1'),
    z, Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
  ])
  assert.equal(countPdfPages(new Uint8Array(pdf)), 180)
})

test('a compressed object stream with page objects in it is counted too', () => {
  const objects = Array.from({ length: 7 }, () => '<< /Type /Page /Parent 1 0 R >>').join(' ')
  const z = deflateSync(Buffer.from(objects, 'latin1'))
  const pdf = Buffer.concat([Buffer.from(`%PDF-1.5\n6 0 obj\n<< /Type /ObjStm /N 7 /First 20 /Filter /FlateDecode >>\nstream\r\n`, 'latin1'), z, Buffer.from('\r\nendstream\nendobj', 'latin1')])
  assert.equal(countPdfPages(new Uint8Array(pdf)), 7)
})

test('unknown layouts and damaged streams give null, never an exception', () => {
  assert.equal(countPdfPages(pdfBytes('<< /Type /Catalog >>')), null)
  const pdf = Buffer.from('%PDF-1.5\n6 0 obj\n<< /Type /ObjStm /Filter /FlateDecode >>\nstream\nthis is not zlib data at all\nendstream\nendobj', 'latin1')
  assert.equal(countPdfPages(new Uint8Array(pdf)), null)
  assert.equal(countPdfPages(new Uint8Array(0)), null)
})

test('a large document is over the default limit', () => {
  const body = ['<< /Type /Pages /Count 400 >>'].join('')
  const n = countPdfPages(pdfBytes(body))
  assert.equal(n, 400)
  assert.ok(n! > cfg().maxPages)
})

test('refund gives a charge back so it no longer counts', () => {
  const g = new PohGuards({ hourlyPerUser: 1, dailyPerUser: 5, dailyGlobal: 50, maxConcurrent: 2, maxPages: 250, maxOutputTokens: 16000 })
  const at = Date.now()
  assert.equal(g.charge('u', at).allowed, true)
  assert.equal(g.charge('u', at + 1).allowed, false)
  g.refund('u', at)
  assert.equal(g.charge('u', at + 2).allowed, true)
})
