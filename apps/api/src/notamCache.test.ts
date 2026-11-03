// The NOTAM disk cache holds the NMS cursor AND the 1-pull-per-24-h state of the MILITARY bulk pull. A truncated
// file (process killed mid-write by a deploy) reads as "unreadable" and repeats both pulls, which gets an NMS
// account throttled. The write goes to a temp file and is renamed over the cache: these tests pin that down.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'notam-cache-'))
process.env['NMS_CACHE_FILE'] = join(dir, 'data', 'notam-cache.json')   // the directory does not exist yet: save creates it
const { _cacheTesting: c } = await import('./notam.js')

const item = (id: string) => ({ id, icaoLocation: 'ESSA', effectiveStart: '2026-01-01T00:00:00Z', effectiveEnd: '2099-01-01T00:00:00Z' })

test('save writes a complete file and leaves no temp file behind', () => {
  c.reset(); c.seed('ESSA', 'n1', item('n1')); c.seed('ESSA', 'n2', item('n2')); c.seed('ESMI', 'n3', item('n3'))
  c.setMilitaryPull('2026-11-03T14:09:36.493Z')
  c.save()
  assert.ok(existsSync(c.file), 'cache file written')
  assert.ok(!existsSync(`${c.file}.tmp`), 'temp file renamed away')
  JSON.parse(readFileSync(c.file, 'utf8'))   // complete, parseable JSON
})

test('a restart loads the entries and the MILITARY pull time back (no repeat pulls)', () => {
  c.reset()
  assert.equal(c.entryCount(), 0)
  c.load()
  assert.equal(c.entryCount(), 3)
  assert.equal(c.militaryPull(), '2026-11-03T14:09:36.493Z')
})

test('a write killed half way leaves the previous complete cache untouched', () => {
  const before = readFileSync(c.file, 'utf8')
  writeFileSync(`${c.file}.tmp`, before.slice(0, Math.floor(before.length / 2)))   // what a killed process leaves behind
  assert.equal(readFileSync(c.file, 'utf8'), before, 'the real file is not the half-written one')
  c.reset(); c.load()
  assert.equal(c.entryCount(), 3, 'the restart still warm-starts')
  assert.equal(c.militaryPull(), '2026-11-03T14:09:36.493Z', 'and still knows the last MILITARY pull')
})

test('the next successful save replaces the stale temp file', () => {
  c.seed('ESSA', 'n4', item('n4'))
  c.save()
  assert.ok(!existsSync(`${c.file}.tmp`))
  c.reset(); c.load()
  assert.equal(c.entryCount(), 4)
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
