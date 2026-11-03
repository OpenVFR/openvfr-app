import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUTHENTICATED_ROLE, assertAuthenticatedRoleExists } from './pgRoles'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations')
const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const createdRoles = (): string[] =>
  migrations.flatMap((f) => [...readFileSync(join(migrationsDir, f), 'utf8').matchAll(/^\s*CREATE ROLE\s+([a-z_][a-z0-9_]*)/gim)].map((m) => m[1]!))

test('the role named in the api token is created by a migration', () => {
  assert.ok(createdRoles().includes(AUTHENTICATED_ROLE), `no migration creates ${AUTHENTICATED_ROLE}`)
})

test('every role the migrations create carries the openvfr_ prefix', () => {
  // Roles are server-wide: an unprefixed `anon` or `authenticator` collides with, and would silently take over,
  // a role of another project on a shared server.
  const bad = createdRoles().filter((r) => !r.startsWith('openvfr_'))
  assert.deepEqual(bad, [], `unprefixed roles: ${bad.join(', ')}`)
  assert.ok(createdRoles().length >= 5, 'expected at least the five service/request roles')
})

test('the migrations never refer to an unprefixed legacy role', () => {
  const legacy = /\b(anon|authenticated|authenticator|api_app|cron_app|martin_ro)\b/
  const hits = migrations.flatMap((f) =>
    readFileSync(join(migrationsDir, f), 'utf8').split('\n')
      .map((line, i) => ({ f, n: i + 1, line }))
      // prose such as "unauthenticated requests" never matches \b...\b, but a comment quoting a legacy name would
      .filter(({ line }) => legacy.test(line) && !line.trim().startsWith('--')))
  assert.deepEqual(hits.map((h) => `${h.f}:${h.n} ${h.line.trim()}`), [])
})

test('startup check: a database without the role is fatal, and the message names the fix', async () => {
  let code: number | undefined
  const errors: string[] = []
  const realError = console.error
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')) }
  try {
    const ended = await assertAuthenticatedRoleExists({ query: async () => ({ rowCount: 0 }) }, (c) => { code = c })
    assert.equal(ended, true)
    assert.equal(code, 1)
    assert.match(errors.join('\n'), /openvfr_authenticated/)
    assert.match(errors.join('\n'), /Upgrading a database/)
  } finally { console.error = realError }
})

test('startup check: the role is there, or the database is unreachable: carry on', async () => {
  let exited = false
  const realWarn = console.warn
  console.warn = () => {}
  try {
    assert.equal(await assertAuthenticatedRoleExists({ query: async () => ({ rowCount: 1 }) }, () => { exited = true }), false)
    assert.equal(await assertAuthenticatedRoleExists({ query: async () => { throw new Error('connection refused') } }, () => { exited = true }), false)
    assert.equal(exited, false)
  } finally { console.warn = realWarn }
})
