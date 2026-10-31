import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RangeSource } from '@open-vfr/shared/terrainDem'
import {
  WxGridFile, answerFromFile, createWxGrid, decodeStream, float32Text, latticeIndex, parseWxGridSources,
  MAX_GRID_AGE_MS, __clearWxBlockCache, type GridHeader, type GridGroup,
} from './wxGrid.js'
import { handleProxy, newProxyState, OPEN_METEO } from './externalProxy.js'

// ── a writer, from the format description in wxGrid.ts ──────────────────────

type Slot = { meta: [number, number, number]; row: (number | null)[] } | null

function encodeBlock(slots: Slot[], scales: number[], nt: number): Buffer {
  const rows: string[] = []
  const rowVals: number[][] = []
  const idx: number[] = []
  const meta: number[] = []
  for (const s of slots) {
    if (!s) { idx.push(255); meta.push(NaN, NaN, NaN); continue }
    const q = s.row.map((v, k) => (v == null ? -32768 : Math.round(v * scales[Math.floor(k / nt)]!)))
    const key = q.join(',')
    let r = rows.indexOf(key)
    if (r < 0) { r = rows.length; rows.push(key); rowVals.push(q) }
    idx.push(r)
    meta.push(...s.meta)
  }
  const stream = rowVals.flat()
  const n = stream.length
  const shuffled = Buffer.alloc(2 * n)
  let prev = 0
  stream.forEach((x, k) => {
    const u = x & 0xffff, d = (u - prev) & 0xffff
    prev = u
    shuffled[k] = d & 0xff
    shuffled[n + k] = d >> 8
  })
  const head = Buffer.alloc(4 + slots.length + 12 * slots.length)
  head.writeUInt16LE(slots.length, 0)
  head.writeUInt16LE(rows.length, 2)
  idx.forEach((v, k) => { head[4 + k] = v })
  meta.forEach((v, k) => head.writeFloatLE(v, 4 + slots.length + 4 * k))
  return deflateSync(Buffer.concat([head, shuffled]))
}

/** File with one block per (group, block index); `blocks[g][b]` = slots or undefined. */
function encodeFile(h: GridHeader, blocks: (Slot[] | undefined)[][]): Buffer {
  const hjson = Buffer.from(JSON.stringify(h))
  const ntiles = Math.ceil(h.nlat / h.tile) * Math.ceil(h.nlon / h.tile)
  const nblocks = ntiles + Math.ceil(h.points.length / (h.tile * h.tile))
  const dir = Buffer.alloc(nblocks * h.groups.length * 8)
  const payloads: Buffer[] = []
  let pos = 12 + hjson.length + dir.length
  h.groups.forEach((g, gi) => {
    for (let b = 0; b < nblocks; b++) {
      const slots = blocks[gi]?.[b]
      if (!slots) continue
      const p = encodeBlock(slots, g.vars.map((v) => v.scale), g.nt)
      dir.writeUInt32LE(pos, (gi * nblocks + b) * 8)
      dir.writeUInt32LE(p.length, (gi * nblocks + b) * 8 + 4)
      payloads.push(p)
      pos += p.length
    }
  })
  const pre = Buffer.alloc(12)
  pre.write('OVWX', 0, 'latin1')
  pre.writeUInt16LE(1, 4)
  pre.writeUInt32LE(hjson.length, 8)
  return Buffer.concat([pre, hjson, dir, ...payloads])
}

class MemSource implements RangeSource {
  reads = 0
  constructor(private readonly buf: Buffer, private readonly key = 'mem') {}
  getKey() { return this.key }
  async getBytes(offset: number, length: number) {
    this.reads++
    const s = this.buf.subarray(offset, Math.min(this.buf.length, offset + length))
    return { data: s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength) as ArrayBuffer }
  }
}

// ── fixture: a 2x2-tile lattice around (59.30, 17.70) + one aerodrome ────────

const NOW = Date.UTC(2026, 9, 31, 21, 20) // 21:20 UTC -> current slot 21:15
const SLOT0 = Date.UTC(2026, 9, 31, 21, 0) / 1000
const DAY0 = Date.UTC(2026, 9, 31) / 1000
const step = 0.05

const current: GridGroup = {
  id: 'current', kind: 'minutely_15', t0: SLOT0, dt: 900, nt: 8,
  vars: [
    { name: 'wind_speed_10m', scale: 10, unit: 'kn' }, { name: 'wind_direction_10m', scale: 1, unit: '°' },
    { name: 'temperature_2m', scale: 10, unit: '°C' }, { name: 'precipitation', scale: 100, unit: 'mm' },
  ],
}
const h850: GridGroup = {
  id: 'hourly_850', kind: 'hourly', t0: DAY0 - 86400, dt: 3600, nt: 17 * 24,
  vars: [{ name: 'wind_speed_850hPa', scale: 10, unit: 'kn' }, { name: 'wind_direction_850hPa', scale: 1, unit: '°' }],
}
const lat0i = Math.round(59.3 / step), lon0i = Math.round(17.7 / step)
const header: GridHeader = {
  version: 1, country: 'se', generatedAt: NOW / 1000 - 600, builtAt: NOW / 1000 - 300,
  step, lat0i, lon0i, nlat: 12, nlon: 9, tile: 8,
  points: [[59.6519, 17.9186]], groups: [current, h850],
}

/** Deterministic values per point/var/time. */
const val = (i: number, j: number, v: number, t: number) => Math.round((i * 7 + j * 3 + v * 11 + t) % 300) / 10
function currentRow(i: number, j: number): (number | null)[] {
  const r: (number | null)[] = []
  for (let v = 0; v < 4; v++) {
    for (let t = 0; t < 8; t++) {
      if (v === 1) r.push((i * 37 + j * 11 + t) % 360)
      else if (v === 3) r.push(t === 3 ? null : ((i + j + t) % 7) / 100)
      else r.push(val(i, j, v, t))
    }
  }
  return r
}
function hourlyRow(i: number, j: number): (number | null)[] {
  const r: (number | null)[] = []
  for (let t = 0; t < h850.nt; t++) r.push(t >= 16 * 24 ? null : val(Math.floor(i / 3), Math.floor(j / 3), 0, t))
  for (let t = 0; t < h850.nt; t++) r.push(t >= 16 * 24 ? null : (Math.floor(i / 3) * 40 + t) % 360)
  return r
}
const metaOf = (i: number, j: number): [number, number, number] => [i * step + 0.0012345, j * step - 0.0023456, (i + j) % 3 === 0 ? 0 : 12.5]

function fixture(): Buffer {
  const ntlon = 2
  const blocks: (Slot[] | undefined)[][] = [[], []]
  for (let di = 0; di < 12; di++) {
    for (let dj = 0; dj < 9; dj++) {
      if (di === 11 && dj === 8) continue // a point outside the mask
      const b = Math.floor(di / 8) * ntlon + Math.floor(dj / 8), s = (di % 8) * 8 + (dj % 8)
      for (const g of [0, 1]) {
        blocks[g]![b] ??= new Array<Slot>(64).fill(null)
        blocks[g]![b]![s] = { meta: metaOf(lat0i + di, lon0i + dj), row: g === 0 ? currentRow(lat0i + di, lon0i + dj) : hourlyRow(lat0i + di, lon0i + dj) }
      }
    }
  }
  // Extra point block (index 4 = after 2x2 tiles), only in "current".
  blocks[0]![4] = [{ meta: [59.65, 17.92, 41], row: currentRow(1, 2) }]
  return encodeFile(header, blocks)
}

const CUR = 'current=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&forecast_days=1&timeformat=unixtime'
const q = (s: string) => new URLSearchParams(s)

beforeEach(() => __clearWxBlockCache())

test('decodeStream undoes delta coding + byte shuffle, nulls included', () => {
  const vals = [0, 5, -3, 32767, -32768, -32767, 100, 100]
  const n = vals.length, buf = new Uint8Array(2 * n)
  let prev = 0
  vals.forEach((x, k) => { const u = x & 0xffff, d = (u - prev) & 0xffff; prev = u; buf[k] = d & 0xff; buf[n + k] = d >> 8 })
  assert.deepEqual([...decodeStream(buf, n)], vals)
})

test('float32Text prints coordinates as Open-Meteo does', () => {
  assert.equal(float32Text(59.34726), '59.34726')
  assert.equal(float32Text(Math.fround(18.056458)), '18.056458')
  assert.equal(float32Text(14), '14')
  assert.equal(float32Text(0), '0')
})

test('latticeIndex accepts lattice points only', () => {
  assert.equal(latticeIndex(59.3, 0.05), 1186)
  assert.equal(latticeIndex(Number('59.30'), 0.05), 1186)
  assert.equal(latticeIndex(59.31, 0.05), null)
})

test('current: answers a lattice point in Open-Meteo shape for the current 15-min slot', async () => {
  const f = await WxGridFile.open('se.wxg', new MemSource(fixture()))
  const body = await answerFromFile(f, q(CUR), 59.35, 17.75, NOW)
  assert.ok(body)
  const j = JSON.parse(body) as { latitude: number; current: Record<string, number>; current_units: Record<string, string>; elevation: number }
  const i = lat0i + 1, jj = lon0i + 1
  assert.deepEqual(j.current, { time: SLOT0 + 900, interval: 900, wind_speed_10m: val(i, jj, 0, 1), wind_direction_10m: (i * 37 + jj * 11 + 1) % 360 })
  assert.deepEqual(j.current_units, { time: 'unixtime', interval: 'seconds', wind_speed_10m: 'kn', wind_direction_10m: '°' })
  assert.equal(j.latitude, Number(float32Text(metaOf(i, jj)[0])))
  // Keys in Open-Meteo's order (clients don't care, but keep the shape).
  assert.match(body, /^\{"latitude":[\d.]+,"longitude":[\d.]+,"generationtime_ms":0,"utc_offset_seconds":0,"timezone":"GMT","timezone_abbreviation":"GMT","elevation":/)
})

test('current: nulls, scales and variable order follow the request', async () => {
  const f = await WxGridFile.open('se.wxg', new MemSource(fixture()))
  const at = Date.UTC(2026, 9, 31, 21, 50) // slot 3 = null precipitation
  const j = JSON.parse((await answerFromFile(f, q('current=precipitation,temperature_2m&wind_speed_unit=kn&timeformat=unixtime'), 59.3, 17.7, at))!) as { current: Record<string, unknown> }
  assert.deepEqual(Object.keys(j.current), ['time', 'interval', 'precipitation', 'temperature_2m'])
  assert.equal(j.current['precipitation'], null)
  assert.equal(j.current['temperature_2m'], val(lat0i, lon0i, 2, 3))
})

test('hourly: past_days + forecast_days series from midnight UTC', async () => {
  const f = await WxGridFile.open('se.wxg', new MemSource(fixture()))
  const s = 'hourly=wind_speed_850hPa,wind_direction_850hPa&wind_speed_unit=kn&forecast_days=2&past_days=1&timeformat=unixtime'
  const j = JSON.parse((await answerFromFile(f, q(s), 59.4, 17.8, NOW))!) as { hourly: { time: number[]; wind_speed_850hPa: number[] } }
  assert.equal(j.hourly.time.length, 72)
  assert.equal(j.hourly.time[0], DAY0 - 86400)
  assert.equal(j.hourly.wind_speed_850hPa[5], val(Math.floor((lat0i + 2) / 3), Math.floor((lon0i + 2) / 3), 0, 5))
  // 16 days + the past day is the whole file; nulls past the model horizon stay null.
  const full = JSON.parse((await answerFromFile(f, q(s.replace('forecast_days=2', 'forecast_days=16')), 59.4, 17.8, NOW))!) as { hourly: { wind_speed_850hPa: (number | null)[] } }
  assert.equal(full.hourly.wind_speed_850hPa.length, 17 * 24)
  assert.equal(full.hourly.wind_speed_850hPa.at(-1), null)
})

test('declines what it does not hold exactly', async () => {
  const f = await WxGridFile.open('se.wxg', new MemSource(fixture()))
  const no = (s: string, la = 59.35, lo = 17.75, at = NOW) => answerFromFile(f, q(s), la, lo, at)
  assert.equal(await no(CUR.replace('kn', 'kmh')), null, 'other wind unit')
  assert.equal(await no(CUR.replace('unixtime', 'iso8601')), null, 'other time format')
  assert.equal(await no(CUR + '&hourly=wind_speed_850hPa'), null, 'current + hourly')
  assert.equal(await no(CUR.replace('wind_speed_10m,', 'wind_gusts_10m,')), null, 'variable not in the file')
  assert.equal(await no('current=wind_speed_10m,wind_speed_850hPa&wind_speed_unit=kn&timeformat=unixtime'), null, 'variables split over groups')
  assert.equal(await no(CUR, 59.31), null, 'off the lattice')
  assert.equal(await no(CUR, 59.85, 18.1), null, 'outside the mask')
  assert.equal(await no(CUR, 60.5), null, 'outside the file')
  assert.equal(await no(CUR, 59.35, 17.75, SLOT0 * 1000 + 8 * 900_000), null, 'past the last slot')
  assert.equal(await no(CUR, 59.35, 17.75, header.generatedAt * 1000 + MAX_GRID_AGE_MS + 1), null, 'file too old')
  assert.equal(await no('hourly=wind_speed_850hPa&wind_speed_unit=kn&forecast_days=3&past_days=2&timeformat=unixtime'), null, 'before the series')
  assert.equal(await no('hourly=wind_speed_850hPa&wind_speed_unit=kn&forecast_days=17&past_days=1&timeformat=unixtime'), null, 'past the series')
})

test('extra points answer at their exact (4-decimal) coordinates', async () => {
  const f = await WxGridFile.open('se.wxg', new MemSource(fixture()))
  const j = JSON.parse((await answerFromFile(f, q(CUR), 59.6519, 17.9186, NOW))!) as { latitude: number; elevation: number; current: Record<string, number> }
  assert.equal(j.latitude, 59.65)
  assert.equal(j.elevation, 41)
  assert.equal(j.current['wind_speed_10m'], val(1, 2, 0, 1))
  // The web map's quantized feature coordinates: a few metres off still count.
  assert.ok(await answerFromFile(f, q(CUR), 59.6522, 17.9183, NOW))
  assert.equal(await answerFromFile(f, q(CUR), 59.6530, 17.9186, NOW), null)
  assert.equal(await answerFromFile(f, q('hourly=wind_speed_850hPa&wind_speed_unit=kn&forecast_days=2&past_days=1&timeformat=unixtime'), 59.6519, 17.9186, NOW), null, 'no hourly block there')
})

test('blocks are read once and then served from memory', async () => {
  const src = new MemSource(fixture())
  const f = await WxGridFile.open('se.wxg', src)
  const opened = src.reads
  await answerFromFile(f, q(CUR), 59.3, 17.7, NOW)
  await answerFromFile(f, q(CUR), 59.35, 17.75, NOW) // same tile
  assert.equal(src.reads - opened, 1)
})

test('rejects files that are not OVWX v1', async () => {
  const bad = fixture()
  bad.write('XXXX', 0, 'latin1')
  await assert.rejects(WxGridFile.open('bad.wxg', new MemSource(bad)), /not an OVWX/)
})

test('parseWxGridSources', () => {
  assert.equal(parseWxGridSources(undefined), 'auto')
  assert.equal(parseWxGridSources(' OFF '), 'off')
  assert.deepEqual(parseWxGridSources('/a/latest.json, https://x/wx/se/latest.json'), ['/a/latest.json', 'https://x/wx/se/latest.json'])
})

// ── live set + relay ─────────────────────────────────────────────────────────

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'wxgrid-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

test('createWxGrid follows the pointer to the current file', async () => {
  await writeFile(join(dir, 'se-1.wxg'), fixture())
  await writeFile(join(dir, 'latest.json'), JSON.stringify({ file: 'se-1.wxg' }))
  let t = NOW
  const grid = createWxGrid({ sources: [join(dir, 'latest.json')], tilesBaseUrl: '', countries: async () => null, now: () => t })!
  const params = q(CUR)
  assert.ok(await grid.answer(params, '59.30', '17.70'))
  assert.equal(grid.status().files[0]!.file, join(dir, 'se-1.wxg'))
  // A broken pointer keeps the previous file (until it is too old).
  await writeFile(join(dir, 'latest.json'), '{')
  t += 3 * 60_000
  assert.ok(await grid.answer(params, '59.30', '17.70'))
  await new Promise((r) => setTimeout(r, 50)) // the refresh runs in the background
  assert.equal(grid.status().errors.length, 1)
  // Logged once, not on every refresh.
  const warns: string[] = []
  const realWarn = console.warn
  console.warn = (...a: unknown[]) => { warns.push(String(a[0])) }
  try {
    t += 3 * 60_000
    await grid.answer(params, '59.30', '17.70')
    await new Promise((r) => setTimeout(r, 50))
  } finally { console.warn = realWarn }
  assert.equal(warns.length, 0)
  assert.ok(await grid.answer(params, '59.30', '17.70'))
  assert.equal(await grid.answer(params, 'x', '17.70'), null)
  // A new build behind the pointer replaces the file.
  await writeFile(join(dir, 'se-2.wxg'), fixture())
  await writeFile(join(dir, 'latest.json'), JSON.stringify({ file: 'se-2.wxg' }))
  t += 3 * 60_000
  await grid.answer(params, '59.30', '17.70')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(grid.status().files[0]!.file, join(dir, 'se-2.wxg'))
  await grid.close()
})

test('auto mode without TILES_BASE_URL, and off, are disabled', () => {
  assert.equal(createWxGrid({ sources: 'auto', tilesBaseUrl: '', countries: async () => ['se'] }), null)
  assert.equal(createWxGrid({ sources: 'off', tilesBaseUrl: 'https://t', countries: async () => ['se'] }), null)
})

test('relay: grid locations cost no upstream call, the rest are fetched', async () => {
  await writeFile(join(dir, 'se-1.wxg'), fixture())
  const grid = createWxGrid({ sources: [join(dir, 'se-1.wxg')], tilesBaseUrl: '', countries: async () => null, now: () => NOW })!
  const local = { answer: (_e: string, p: URLSearchParams) => grid.answer(p, p.get('latitude')!, p.get('longitude')!), perUser: { hourly: 3000, daily: 20000 }, anonymous: { hourly: 10, daily: 10 } }
  const calls: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (u: string | URL) => {
    calls.push(String(u))
    const lat = new URL(String(u)).searchParams.get('latitude')!.split(',')
    const els = lat.map((la) => ({ live: la }))
    return new Response(JSON.stringify(els.length === 1 ? els[0] : els), { status: 200 })
  }) as typeof fetch
  try {
    const s = newProxyState()
    const all = await handleProxy(OPEN_METEO, s, 'u1', '/api/open-meteo/forecast', `?latitude=59.30,59.35&longitude=17.70,17.75&${CUR}`, () => NOW, local)
    assert.equal(all.status, 200)
    assert.equal(all.headers.get('X-Cache'), 'LOCAL')
    assert.equal(calls.length, 0)
    assert.equal((JSON.parse(await all.text()) as unknown[]).length, 2)
    // One point outside every grid: only it goes upstream; order is kept.
    const mixed = await handleProxy(OPEN_METEO, s, 'u1', '/api/open-meteo/forecast', `?latitude=59.30,62.00,59.35&longitude=17.70,15.00,17.75&${CUR}`, () => NOW, local)
    assert.equal(mixed.headers.get('X-Cache'), 'MISS')
    assert.equal(calls.length, 1)
    assert.equal(new URL(calls[0]!).searchParams.get('latitude'), '62.00')
    const els = JSON.parse(await mixed.text()) as Record<string, unknown>[]
    assert.ok('current' in els[0]!)
    assert.deepEqual(els[1], { live: '62.00' })
    assert.ok('current' in els[2]!)
    // Grid answers don't touch the user's upstream quota.
    assert.equal((s.userMisses.get('u1') ?? []).length, 1)
  } finally {
    await grid.close()
    globalThis.fetch = realFetch
  }
})
