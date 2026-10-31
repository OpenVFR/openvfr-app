import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectiveMinBuilds, envMinBuilds, parseBuild, recordLaunch, resetSeenBuilds, seenBuilds } from './appVersion.js'

test('parseBuild accepts whole numbers in range only', () => {
  assert.equal(parseBuild('57'), 57)
  assert.equal(parseBuild(' 57 '), 57)
  assert.equal(parseBuild(0), 0)
  for (const bad of ['', '5.7', '-1', '1e3', 'abc', '99999999999', -1, 1.5, NaN, null, undefined]) {
    assert.equal(parseBuild(bad), null, String(bad))
  }
})

test('env defaults: unset or junk = 0 (no minimum)', () => {
  assert.deepEqual(envMinBuilds({}), { android: 0, ios: 0 })
  assert.deepEqual(envMinBuilds({ APP_MIN_BUILD_ANDROID: '40', APP_MIN_BUILD_IOS: 'x' }), { android: 40, ios: 0 })
})

test('a stored minimum overrides the env default for its platform only', () => {
  const env = { android: 10, ios: 20 }
  assert.deepEqual(effectiveMinBuilds(null, env), env)
  assert.deepEqual(effectiveMinBuilds([{ platform: 'android', minBuild: 3, updatedAt: '', updatedBy: null }], env), { android: 3, ios: 20 })
})

test('launches are counted per build, newest build first, bounded in size', () => {
  resetSeenBuilds()
  recordLaunch('android', 55, 1)
  recordLaunch('android', 57, 2)
  recordLaunch('android', 57, 3)
  const s = seenBuilds()
  assert.deepEqual(s.android.map(b => [b.build, b.launches]), [[57, 2], [55, 1]])
  assert.deepEqual(s.ios, [])
  for (let i = 0; i < 200; i++) recordLaunch('ios', 1000 + i, 10 + i)
  assert.equal(seenBuilds().ios.length, 50)
  // The most recently seen ones stay.
  assert.equal(seenBuilds().ios[0]?.build, 1199)
})
