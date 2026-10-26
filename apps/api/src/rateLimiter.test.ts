import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RateLimiter, limitFromEnv } from './rateLimiter.js'

const MIN = 60_000
const HOUR = 60 * MIN

test('allows up to max per window, then reports the wait until the oldest hit expires', () => {
  const l = new RateLimiter([{ windowMs: HOUR, max: 2 }])
  const t0 = 1_000_000
  assert.equal(l.take('u', t0).waitS, 0)
  assert.equal(l.take('u', t0 + MIN).waitS, 0)
  const r = l.take('u', t0 + 2 * MIN)
  assert.equal(r.waitS, (HOUR - 2 * MIN) / 1000)
  assert.equal(r.limit?.max, 2)
  // Once the first hit leaves the window there is room again.
  assert.equal(l.take('u', t0 + HOUR).waitS, 0)
})

test('check() never records', () => {
  const l = new RateLimiter([{ windowMs: HOUR, max: 1 }])
  for (let i = 0; i < 5; i++) assert.equal(l.check('u', 1000).waitS, 0)
  assert.equal(l.take('u', 1000).waitS, 0)
  assert.ok(l.check('u', 1001).waitS > 0)
})

test('the tighter of several windows wins, and the longest wait is reported', () => {
  const l = new RateLimiter([{ windowMs: HOUR, max: 5 }, { windowMs: 24 * HOUR, max: 6 }])
  const t0 = 0
  for (let i = 0; i < 5; i++) assert.equal(l.take('u', t0 + i).waitS, 0)
  assert.equal(l.take('u', t0 + 10).limit?.max, 5)        // hourly blocks
  assert.equal(l.take('u', t0 + HOUR + 10).waitS, 0)       // 6th of the day
  const r = l.take('u', t0 + 2 * HOUR)                     // daily blocks
  assert.equal(r.limit?.max, 6)
  assert.equal(r.waitS, Math.ceil((24 * HOUR - 2 * HOUR) / 1000))
})

test('keys are independent', () => {
  const l = new RateLimiter([{ windowMs: HOUR, max: 1 }])
  assert.equal(l.take('a', 0).waitS, 0)
  assert.equal(l.take('b', 0).waitS, 0)
  assert.ok(l.take('a', 1).waitS > 0)
})

test('weight counts as several hits; a weight above max can never pass', () => {
  const l = new RateLimiter([{ windowMs: HOUR, max: 10 }])
  assert.equal(l.take('u', 0, 7).waitS, 0)
  assert.ok(l.take('u', 1, 4).waitS > 0)
  assert.equal(l.take('u', 1, 3).waitS, 0)
  assert.equal(l.check('v', 0, 11).waitS, HOUR / 1000)
})

test('sweep drops keys whose hits all left the window', () => {
  const l = new RateLimiter([{ windowMs: HOUR, max: 5 }])
  l.record('old', 0)
  l.record('new', HOUR)
  assert.equal(l.size, 2)
  l.sweep(HOUR + 1)
  assert.equal(l.size, 1)
  assert.equal(l.check('new', HOUR + 1).waitS, 0)
})

test('keys are swept automatically as records accumulate', () => {
  const l = new RateLimiter([{ windowMs: MIN, max: 5 }])
  for (let i = 0; i < 999; i++) l.record(`ip${i}`, 0)
  assert.equal(l.size, 999)
  l.record('late', 2 * MIN) // 1000th record triggers a sweep
  assert.equal(l.size, 1)
})

test('limitFromEnv: blank or invalid falls back, never 0', () => {
  assert.equal(limitFromEnv('X', 30, {}), 30)
  assert.equal(limitFromEnv('X', 30, { X: '' }), 30)
  assert.equal(limitFromEnv('X', 30, { X: '  ' }), 30)
  assert.equal(limitFromEnv('X', 30, { X: '0' }), 30)
  assert.equal(limitFromEnv('X', 30, { X: '-5' }), 30)
  assert.equal(limitFromEnv('X', 30, { X: '2.5' }), 30)
  assert.equal(limitFromEnv('X', 30, { X: 'abc' }), 30)
  assert.equal(limitFromEnv('X', 30, { X: ' 50 ' }), 50)
})
