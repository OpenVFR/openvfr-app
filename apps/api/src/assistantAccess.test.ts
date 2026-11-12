import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAssistantAccess } from './assistantAccess.js'

const row = (over: Record<string, unknown> = {}) => ({ rows: [{ banned: false, banExpires: null, scopes: ['a', 'b'], ...over }] })

test('check answers the scopes the consent grants now, and null with no consent, no user or a ban', async () => {
  const q = (r: { rows: Record<string, unknown>[] }) => createAssistantAccess(async () => r, 0)
  assert.deepEqual(await q(row()).check('u', 'c'), ['a', 'b'])
  assert.equal(await q(row({ scopes: null })).check('u', 'c'), null)
  assert.equal(await q({ rows: [] }).check('u', 'c'), null)
  assert.equal(await q(row({ banned: true })).check('u', 'c'), null)
  assert.deepEqual(await q(row({ banned: true, banExpires: '2000-01-01T00:00:00Z' })).check('u', 'c'), ['a', 'b'])
  assert.equal(await q(row()).allowed('u', 'c'), true)
})

test('a narrowed consent is seen once the cache entry has expired, and a failing query throws instead of answering "no"', async () => {
  let t = 1_000
  let scopes: string[] = ['a', 'b']
  const access = createAssistantAccess(async () => ({ rows: [{ banned: false, banExpires: null, scopes }] }), 10_000, () => t)
  assert.deepEqual(await access.check('u', 'c'), ['a', 'b'])
  scopes = ['a']
  assert.deepEqual(await access.check('u', 'c'), ['a', 'b'])   // cached
  t += 10_001
  assert.deepEqual(await access.check('u', 'c'), ['a'])
  const broken = createAssistantAccess(async () => { throw new Error('db down') }, 0)
  await assert.rejects(() => broken.check('u', 'c'), /db down/)
})
