/**
 * wxGrid — answers /api/open-meteo/forecast locations from precomputed
 * per-country weather grid files, so in-country requests never touch the
 * public Open-Meteo API (free tier: limited per IP, i.e. one small budget
 * shared by every user of this server).
 *
 * A grid file holds, for every point the apps can ask for inside a country
 * (+ a buffer), exactly what Open-Meteo answers for that point with its
 * default model selection: the apps snap coordinates to a 0.05° lattice
 * (snapCoord) and the weather-station view asks at aerodrome coordinates (4
 * decimals), so a finite set of points covers every in-country request. A
 * data pipeline builds it from a self-hosted Open-Meteo instance after each
 * model update (see docs/self-hosting.md, "Weather grid"). Points the file
 * does not cover, request shapes it does not hold, or a file too old fall
 * through to the normal relay path (cache, then upstream).
 *
 * File format ("OVWX" v1, little endian):
 *   0  "OVWX" | u16 version | u16 0 | u32 headerLen | header JSON
 *   then a directory: per group, per block, u32 offset (0 = none) + u32 length
 *   then zlib blocks. Lattice points (multiples of `step`) are grouped in
 *   tiles of tile x tile points, row-major from (lat0i, lon0i); exact extra
 *   points (`points`) follow in blocks of tile*tile in list order.
 *   Block (inflated): u16 nslots, u16 nrows, u8 row[nslots] (255 = none),
 *   f32 meta[nslots][3] (latitude, longitude, elevation of the answer),
 *   then nrows rows of nvars*nt int16 as one stream, delta-coded mod 2^16
 *   and byte-shuffled (all low bytes, then all high bytes). -32768 = null;
 *   value = int / var.scale.
 *   Group kinds: "minutely_15" (Open-Meteo `current` is the minutely_15
 *   value of the current 15-min slot) and "hourly".
 *
 * Sources (env WX_GRID_SOURCES):
 *  - unset: `${TILES_BASE_URL}/wx/<cc>/latest.json` for every country the
 *    registry lists as available (none when TILES_BASE_URL is unset);
 *  - `off`: disabled;
 *  - otherwise a comma-separated list of `latest.json` pointers or `.wxg`
 *    files (http/https URLs or absolute paths).
 * A pointer is `{ "file": "<name>.wxg", ... }`, resolved next to it. Files
 * are immutable (a new build = a new name), read with Range requests; only
 * the header/directory and the blocks a request touches are fetched.
 */

import { inflate } from 'node:zlib'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RangeSource } from '@open-vfr/shared/terrainDem'
import { HttpRangeSource, FileRangeSource, parseLocalSources } from './demElevation'

const inflateAsync = promisify(inflate)

const MAGIC = 'OVWX'
const VERSION = 1
const NULL = -32768
const NO_ROW = 255
/** Pointers are re-read this often (a new build appears about hourly). */
const REFRESH_MS = 2 * 60 * 1000
/** Answers come only from a file built at most this long ago. One missed
 *  build is bridged; after that the relay asks upstream again. Same bound
 *  as the apps' failure-only fallback for forecast series. */
export const MAX_GRID_AGE_MS = 2 * 60 * 60 * 1000
/** Inflated blocks kept in memory, across all files. */
const BLOCK_CACHE_BYTES = 48 * 1024 * 1024
const POINTER_TIMEOUT_MS = 10_000
/** Longest a request waits for the very first refresh before going upstream. */
const FIRST_REFRESH_WAIT_MS = 2_000
/** Sanity caps on what a file may make us read or allocate. */
const MAX_HEADER_BYTES = 4 * 1024 * 1024
const MAX_DIR_BYTES = 4 * 1024 * 1024
const MAX_BLOCK_BYTES = 16 * 1024 * 1024
/** Extra points (aerodromes) also answer requests this close (~50 m): the
 *  web map hands out feature coordinates quantized to its tile grid, so the
 *  4 decimals it sends move with the zoom level. Same aerodrome, same
 *  model cell; only the reported grid distance moves by metres. */
const POINT_TOLERANCE_DEG = 0.0005

export interface GridVar { name: string; scale: number; unit?: string }
export interface GridGroup { id: string; kind: 'minutely_15' | 'hourly'; t0: number; dt: number; nt: number; vars: GridVar[] }
export interface GridHeader {
  version: number
  country: string
  generatedAt: number
  builtAt: number | null
  step: number
  lat0i: number; lon0i: number; nlat: number; nlon: number
  tile: number
  points: [number, number][]
  groups: GridGroup[]
}

interface Block { idx: Uint8Array; meta: Float32Array; rows: Int16Array; bytes: number }

/** Shared LRU of inflated blocks (Map iterates in insertion order). */
const blockCache = new Map<string, Block>()
let blockCacheBytes = 0

function cacheGet(key: string): Block | undefined {
  const b = blockCache.get(key)
  if (b) { blockCache.delete(key); blockCache.set(key, b) }
  return b
}

function cachePut(key: string, b: Block): void {
  blockCache.set(key, b)
  blockCacheBytes += b.bytes
  for (const [k, v] of blockCache) {
    if (blockCacheBytes <= BLOCK_CACHE_BYTES) break
    blockCache.delete(k)
    blockCacheBytes -= v.bytes
  }
}

/** Block loads in progress, keyed like the cache: concurrent readers of one
 *  block (a map view's points mostly share one tile) share one read + inflate. */
const blockLoads = new Map<string, Promise<Block>>()

/** Test-only. */
export function __clearWxBlockCache(): void { blockCache.clear(); blockCacheBytes = 0; blockLoads.clear() }

/** True when a grid is too old to answer from (its builder stopped). */
export function gridTooOld(h: GridHeader, nowMs: number): boolean {
  return nowMs - h.generatedAt * 1000 > MAX_GRID_AGE_MS
}

/** Tiles in the lattice and blocks per group (tiles + extra-point blocks). */
function blockLayout(h: GridHeader): { ntlat: number; ntlon: number; nblocks: number } {
  const ntlat = Math.ceil(h.nlat / h.tile), ntlon = Math.ceil(h.nlon / h.tile)
  return { ntlat, ntlon, nblocks: ntlat * ntlon + Math.ceil(h.points.length / (h.tile * h.tile)) }
}

const isInt = (x: unknown, lo: number, hi: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi

/** Throws unless the header is complete and within sane bounds. Exported for tests. */
export function validateHeader(h: unknown): asserts h is GridHeader {
  const x = h as Partial<GridHeader> | null
  const bad = (what: string) => { throw new Error(`wx grid: invalid header (${what})`) }
  if (!x || typeof x !== 'object') bad('not an object')
  if (typeof x!.generatedAt !== 'number' || !Number.isFinite(x!.generatedAt) || x!.generatedAt <= 0) bad('generatedAt')
  if (typeof x!.step !== 'number' || !(x!.step > 0 && x!.step <= 1)) bad('step')
  if (!isInt(x!.tile, 1, 64)) bad('tile')
  if (!isInt(x!.nlat, 1, 20000) || !isInt(x!.nlon, 1, 20000)) bad('nlat/nlon')
  if (!isInt(x!.lat0i, -1e6, 1e6) || !isInt(x!.lon0i, -1e6, 1e6)) bad('lat0i/lon0i')
  if (!Array.isArray(x!.points) || x!.points.length > 100_000 || !x!.points.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) bad('points')
  if (!Array.isArray(x!.groups) || x!.groups.length === 0 || x!.groups.length > 64) bad('groups')
  for (const g of x!.groups!) {
    if (!g || (g.kind !== 'minutely_15' && g.kind !== 'hourly') || typeof g.id !== 'string') bad('group kind/id')
    if (!isInt(g.t0, 0, 2 ** 40) || !isInt(g.dt, 1, 86400) || !isInt(g.nt, 1, 10000)) bad(`group ${g.id} time axis`)
    if (!Array.isArray(g.vars) || g.vars.length === 0 || g.vars.length > 64 ||
      !g.vars.every((v) => typeof v?.name === 'string' && isInt(v.scale, 1, 1_000_000))) bad(`group ${g.id} vars`)
  }
}

/** Inverse of the writer's delta coding + byte shuffle. Exported for tests. */
export function decodeStream(buf: Uint8Array, n: number): Int16Array {
  const out = new Int16Array(n)
  let acc = 0
  for (let k = 0; k < n; k++) {
    acc = (acc + (buf[k]! | (buf[n + k]! << 8))) & 0xffff
    out[k] = acc >= 0x8000 ? acc - 0x10000 : acc
  }
  return out
}

/** Parses one inflated block. Exported for tests. */
export function parseBlock(raw: Uint8Array, nvals: number): Block {
  if (raw.byteLength < 4) throw new Error('wx grid: truncated block')
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const nslots = dv.getUint16(0, true), nrows = dv.getUint16(2, true)
  let o = 4
  if (raw.byteLength < o + 13 * nslots) throw new Error('wx grid: truncated block')
  const idx = raw.slice(o, o + nslots); o += nslots
  for (const r of idx) if (r !== NO_ROW && r >= nrows) throw new Error('wx grid: row index out of range')
  const meta = new Float32Array(nslots * 3)
  for (let k = 0; k < nslots * 3; k++) meta[k] = dv.getFloat32(o + 4 * k, true)
  o += 12 * nslots
  const n = nrows * nvals
  if (raw.byteLength < o + 2 * n) throw new Error('wx grid: truncated block')
  const rows = decodeStream(raw.subarray(o, o + 2 * n), n)
  return { idx, meta, rows, bytes: idx.byteLength + meta.byteLength + rows.byteLength + 64 }
}

/** Index of a coordinate on the lattice, or null off-lattice. Exported for tests. */
export function latticeIndex(deg: number, step: number): number | null {
  const k = Math.round(deg / step)
  return Math.abs(k * step - deg) < 1e-7 ? k : null
}

/** Shortest decimal that reads back as the same float32 (how Open-Meteo prints coordinates). */
export function float32Text(x: number): string {
  if (!Number.isFinite(x)) return 'null'
  const f = Math.fround(x)
  for (let p = 1; p <= 9; p++) {
    const s = Number(f.toPrecision(p))
    if (Math.fround(s) === f) return String(s)
  }
  return String(f)
}

const pointKey = (lat: number, lon: number) => `${lat.toFixed(4)},${lon.toFixed(4)}`

/** One opened grid file: header + directory in memory, blocks read on demand. */
export class WxGridFile {
  readonly header: GridHeader
  private readonly dir: DataView
  private readonly ntlat: number
  private readonly ntlon: number
  private readonly nblocks: number
  private readonly pointIdx: Map<string, number>
  /** Set by close(): reads return null instead of touching the source again. */
  private closed = false

  private constructor(readonly name: string, private readonly source: RangeSource, header: GridHeader, dir: DataView) {
    this.header = header
    this.dir = dir
    ;({ ntlat: this.ntlat, ntlon: this.ntlon, nblocks: this.nblocks } = blockLayout(header))
    this.pointIdx = new Map(header.points.map((p, k) => [pointKey(p[0], p[1]), k]))
  }

  static async open(name: string, source: RangeSource): Promise<WxGridFile> {
    const first = new Uint8Array((await source.getBytes(0, 65536)).data)
    if (first.byteLength < 12) throw new Error(`wx grid ${name}: too short`)
    const dv = new DataView(first.buffer, first.byteOffset, first.byteLength)
    const magic = String.fromCharCode(first[0]!, first[1]!, first[2]!, first[3]!)
    const version = dv.getUint16(4, true)
    if (magic !== MAGIC || version !== VERSION) throw new Error(`wx grid ${name}: not an OVWX v${VERSION} file`)
    const hlen = dv.getUint32(8, true)
    if (hlen > MAX_HEADER_BYTES) throw new Error(`wx grid ${name}: header of ${hlen} bytes refused`)
    const head = 12 + hlen <= first.byteLength ? first : new Uint8Array((await source.getBytes(0, 12 + hlen)).data)
    if (head.byteLength < 12 + hlen) throw new Error(`wx grid ${name}: short header`)
    const header: unknown = JSON.parse(new TextDecoder().decode(head.subarray(12, 12 + hlen)))
    validateHeader(header)
    const dirLen = blockLayout(header).nblocks * header.groups.length * 8
    if (dirLen > MAX_DIR_BYTES) throw new Error(`wx grid ${name}: directory of ${dirLen} bytes refused`)
    const dirBuf = new Uint8Array((await source.getBytes(12 + hlen, dirLen)).data)
    if (dirBuf.byteLength !== dirLen) throw new Error(`wx grid ${name}: short directory`)
    return new WxGridFile(name, source, header, new DataView(dirBuf.buffer, dirBuf.byteOffset, dirBuf.byteLength))
  }

  /** Releases the file handle (local files) and this file's cached blocks. */
  async close(): Promise<void> {
    this.closed = true
    for (const [k, b] of blockCache) {
      if (k.startsWith(`${this.name}|`)) { blockCache.delete(k); blockCacheBytes -= b.bytes }
    }
    if (this.source instanceof FileRangeSource) await this.source.close()
  }

  /** Reads, inflates and parses one block; at most once at a time per block. */
  private loadBlock(key: string, off: number, len: number, nvals: number, nslots: number): Promise<Block> {
    let p = blockLoads.get(key)
    if (!p) {
      p = (async () => {
        if (len > MAX_BLOCK_BYTES) throw new Error(`wx grid ${this.name}: block of ${len} bytes refused`)
        const data = new Uint8Array((await this.source.getBytes(off, len)).data)
        if (data.byteLength !== len) throw new Error(`wx grid ${this.name}: short block read`)
        // Upper bound of the inflated block: header, index, meta, every slot its own row.
        const maxOut = 4 + 13 * nslots + 2 * nslots * nvals
        const b = parseBlock(new Uint8Array(await inflateAsync(data, { maxOutputLength: maxOut })), nvals)
        if (!this.closed) cachePut(key, b)
        return b
      })().finally(() => blockLoads.delete(key))
      blockLoads.set(key, p)
    }
    return p
  }

  /** [block, slot] of a point, or null when the file has no such point. */
  slotOf(lat: number, lon: number): [number, number] | null {
    const h = this.header
    const i = latticeIndex(lat, h.step), j = latticeIndex(lon, h.step)
    if (i != null && j != null) {
      const di = i - h.lat0i, dj = j - h.lon0i
      if (di >= 0 && di < h.nlat && dj >= 0 && dj < h.nlon) {
        return [Math.floor(di / h.tile) * this.ntlon + Math.floor(dj / h.tile), (di % h.tile) * h.tile + (dj % h.tile)]
      }
    }
    let k = this.pointIdx.get(pointKey(lat, lon))
    if (k == null) {
      let best = Infinity
      h.points.forEach(([pa, po], n) => {
        const d = Math.max(Math.abs(pa - lat), Math.abs(po - lon))
        if (d <= POINT_TOLERANCE_DEG && d < best) { best = d; k = n }
      })
    }
    if (k == null) return null
    const per = h.tile * h.tile
    return [this.ntlat * this.ntlon + Math.floor(k / per), k % per]
  }

  /** Values of one group at one point: meta + row (nvars*nt int16), or null (not covered). */
  async read(g: number, lat: number, lon: number): Promise<{ meta: [number, number, number]; row: Int16Array } | null> {
    if (this.closed) return null
    const s = this.slotOf(lat, lon)
    if (!s) return null
    const [block, slot] = s
    const e = (g * this.nblocks + block) * 8
    const off = this.dir.getUint32(e, true), len = this.dir.getUint32(e + 4, true)
    if (off === 0) return null
    const grp = this.header.groups[g]!
    const nvals = grp.vars.length * grp.nt
    const key = `${this.name}|${g}|${block}`
    const b = cacheGet(key) ?? await this.loadBlock(key, off, len, nvals, this.header.tile * this.header.tile)
    const r = b.idx[slot]
    if (r == null || r === NO_ROW) return null
    return { meta: [b.meta[3 * slot]!, b.meta[3 * slot + 1]!, b.meta[3 * slot + 2]!], row: b.rows.subarray(r * nvals, (r + 1) * nvals) }
  }
}

const DAY_S = 86400

function unitsJson(vars: { name: string; unit?: string }[], first: Record<string, string>): string {
  const u: Record<string, string> = { ...first }
  for (const v of vars) u[v.name] = v.unit ?? ''
  return JSON.stringify(u)
}

function value(x: number, scale: number): string {
  return x === NULL ? 'null' : String(x / scale)
}

/**
 * Open-Meteo-shaped answer for ONE location from one file, or null when the
 * file can't answer this exact request. `q` holds the request's parameters
 * except latitude/longitude. Exported for tests.
 */
export async function answerFromFile(f: WxGridFile, q: URLSearchParams, lat: number, lon: number, nowMs: number): Promise<string | null> {
  const h = f.header
  if (gridTooOld(h, nowMs)) return null
  // The file holds knots and unix times, which is what the apps ask for.
  if (q.get('wind_speed_unit') !== 'kn' || (q.get('timeformat') ?? 'iso8601') !== 'unixtime') return null
  const current = q.get('current'), hourly = q.get('hourly')
  if (!!current === !!hourly) return null
  const wanted = (current ?? hourly)!.split(',')
  const kind = current ? 'minutely_15' : 'hourly'
  const g = h.groups.findIndex((gr) => gr.kind === kind && wanted.every((w) => gr.vars.some((v) => v.name === w)))
  if (g < 0) return null
  const grp = h.groups[g]!
  const nowS = Math.floor(nowMs / 1000)
  let from: number, count: number
  if (current) {
    from = Math.floor(nowS / grp.dt) * grp.dt
    count = 1
  } else {
    const past = Number(q.get('past_days') ?? 0), days = Number(q.get('forecast_days') ?? 7)
    from = Math.floor(nowS / DAY_S) * DAY_S - past * DAY_S
    count = ((past + days) * DAY_S) / grp.dt
  }
  const k0 = (from - grp.t0) / grp.dt
  if (!Number.isInteger(k0) || k0 < 0 || k0 + count > grp.nt) return null
  const hit = await f.read(g, lat, lon)
  if (!hit) return null
  const col = (name: string) => grp.vars.findIndex((v) => v.name === name)
  const series = (name: string) => {
    const v = col(name), base = v * grp.nt + k0, sc = grp.vars[v]!.scale
    const out: string[] = []
    for (let k = 0; k < count; k++) out.push(value(hit.row[base + k]!, sc))
    return out
  }
  const vars = wanted.map((w) => grp.vars[col(w)]!)
  let block: string
  if (current) {
    block = `"current_units":${unitsJson(vars, { time: 'unixtime', interval: 'seconds' })},"current":{"time":${from},"interval":${grp.dt}${
      wanted.map((w) => `,${JSON.stringify(w)}:${series(w)[0]}`).join('')}}`
  } else {
    const times: number[] = []
    for (let k = 0; k < count; k++) times.push(from + k * grp.dt)
    block = `"hourly_units":${unitsJson(vars, { time: 'unixtime' })},"hourly":{"time":[${times.join(',')}]${
      wanted.map((w) => `,${JSON.stringify(w)}:[${series(w).join(',')}]`).join('')}}`
  }
  const [la, lo, el] = hit.meta
  return `{"latitude":${float32Text(la)},"longitude":${float32Text(lo)},"generationtime_ms":0,"utc_offset_seconds":0,` +
    `"timezone":"GMT","timezone_abbreviation":"GMT","elevation":${Number.isFinite(el) ? float32Text(el) : 'null'},${block}}`
}

/** Parses WX_GRID_SOURCES (same rules as ELEVATION_DEM_SOURCES). Exported for tests. */
export const parseWxGridSources = (v: string | undefined) => parseLocalSources(v, 'WX_GRID_SOURCES')

const GRID_FILE = /\.wxg$/i

const isUrl = (s: string) => /^https?:\/\//i.test(s)

async function readPointer(location: string): Promise<{ file: string }> {
  const text = isUrl(location)
    ? await fetch(location, { headers: { 'User-Agent': 'open-vfr/1.0' }, signal: AbortSignal.timeout(POINTER_TIMEOUT_MS), cache: 'no-store' })
      .then((r) => { if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { notFound: r.status === 404 }); return r.text() })
    : await readFile(location, 'utf8')
  const p = JSON.parse(text) as { file?: unknown }
  if (typeof p.file !== 'string' || !/^[A-Za-z0-9._-]+$/.test(p.file) || !GRID_FILE.test(p.file)) throw new Error('pointer has no valid "file"')
  return { file: p.file }
}

function resolveNext(location: string, file: string): string {
  return isUrl(location) ? new URL(file, location).toString() : join(dirname(location), file)
}

export interface WxGridStatus {
  files: { country: string; file: string; generatedAt: string; ageMin: number; usable: boolean }[]
  /** Sources that could not be read (a real problem). */
  errors: string[]
  /** Sources with no grid published (yet): expected for countries without one. */
  missing: string[]
  blockCache: { blocks: number; bytes: number }
}

/**
 * The live set of grid files. Returns the per-location answerer the relay
 * calls (null when disabled) and a status snapshot for the admin API.
 * Never throws: a missing/unreadable pointer or file just isn't used (the
 * previous file of that source is kept until it is too old).
 */
export function createWxGrid(opts: {
  sources: 'auto' | 'off' | string[]
  tilesBaseUrl: string
  countries: () => Promise<string[] | null>
  open?: (location: string) => Promise<WxGridFile>
  now?: () => number
}): { answer: (q: URLSearchParams, lat: string, lng: string) => Promise<string | null>; status: () => WxGridStatus; close: () => Promise<void> } | null {
  if (opts.sources === 'off') return null
  if (opts.sources === 'auto' && !opts.tilesBaseUrl) return null
  const now = opts.now ?? Date.now
  const open = opts.open ?? ((loc: string) => WxGridFile.open(loc, isUrl(loc)
    ? new HttpRangeSource(loc, fetch, { maxBytes: MAX_BLOCK_BYTES, label: 'wx grid' })
    : new FileRangeSource(loc)))
  let files = new Map<string, WxGridFile>()   // source location -> current file
  let errors: string[] = []
  let missingNow: string[] = []
  // Dropped files are closed one refresh later, so requests still reading
  // them (answer() iterates across awaits) finish first.
  let retired: WxGridFile[] = []
  // Read failures are logged once per file, not per request.
  const readFailed = new Set<string>()
  // Logged on change only: the production log watcher alerts on every stderr line.
  let lastProblems = ''
  const stale = new Set<string>()
  let nextAt = 0
  let refreshing: Promise<void> | null = null
  let ready = false

  const refresh = async () => {
    let locations: string[]
    if (opts.sources === 'auto') {
      const codes = await opts.countries().catch(() => null)
      if (!codes) { nextAt = now() + REFRESH_MS; return }
      locations = codes.map((c) => `${opts.tilesBaseUrl}/wx/${c}/latest.json`)
    } else {
      locations = opts.sources as string[]
    }
    for (const f of retired) void f.close()
    retired = []
    const next = new Map<string, WxGridFile>()
    const errs: string[] = []
    const missing: string[] = []
    await Promise.all(locations.map(async (loc) => {
      try {
        const target = GRID_FILE.test(loc) ? loc : resolveNext(loc, (await readPointer(loc)).file)
        const prev = files.get(loc)
        // Files are immutable: same name = same content, keep the opened one.
        next.set(loc, prev && prev.name === target ? prev : await open(target))
      } catch (err) {
        // No pointer yet (country without a grid): expected, not a problem.
        if ((err as { notFound?: boolean }).notFound || (err as { code?: string }).code === 'ENOENT') missing.push(loc)
        else errs.push(`${loc}: ${(err as Error)?.message}`)
        const prev = files.get(loc)
        if (prev) next.set(loc, prev)
      }
    }))
    const before = new Set([...files.values()].map((f) => f.name))
    const after = new Set([...next.values()].map((f) => f.name))
    retired = [...files.values()].filter((f) => !after.has(f.name))
    for (const f of retired) readFailed.delete(f.name)
    for (const f of next.values()) if (!before.has(f.name)) console.log(`[wx-grid] using ${f.name} (${f.header.country}, generated ${new Date(f.header.generatedAt * 1000).toISOString()})`)
    const problems = errs.join('; ')
    if (problems !== lastProblems) {
      if (errs.length) console.warn(`[wx-grid] ${errs.length} source(s) unreadable: ${problems.slice(0, 500)}`)
      else if (lastProblems) console.log('[wx-grid] all sources readable again')
      lastProblems = problems
    }
    // A grid ageing out means its builder stopped: say so once, and once when it recovers.
    for (const f of next.values()) {
      const old = gridTooOld(f.header, now())
      if (old && !stale.has(f.name)) { stale.add(f.name); console.warn(`[wx-grid] ${f.name} (${f.header.country}) is older than ${MAX_GRID_AGE_MS / 3600_000} h and no newer grid is published: these requests use Open-Meteo upstream again`) }
    }
    for (const n of [...stale]) if (![...next.values()].some((f) => f.name === n)) stale.delete(n)
    files = next
    errors = errs
    missingNow = missing
    ready = true
    nextAt = now() + REFRESH_MS
  }
  const ensure = async () => {
    if (now() < nextAt) return
    refreshing ??= refresh().finally(() => { refreshing = null })
    // First refresh: wait a little, never long (a slow tile host must not
    // stall requests; they go upstream until the grids are known).
    if (!ready) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([refreshing, new Promise<void>((r) => { timer = setTimeout(r, FIRST_REFRESH_WAIT_MS) })])
      clearTimeout(timer)
    }
  }

  return {
    async answer(q, lat, lng) {
      await ensure().catch(() => {})
      const la = Number(lat), lo = Number(lng)
      if (!Number.isFinite(la) || !Number.isFinite(lo)) return null
      const t = now()
      for (const f of files.values()) {
        try {
          const a = await answerFromFile(f, q, la, lo, t)
          if (a) return a
        } catch (err) {
          if (!readFailed.has(f.name)) {
            readFailed.add(f.name)
            console.warn(`[wx-grid] read failed (${f.name}), answering upstream instead:`, (err as Error)?.message)
          }
        }
      }
      return null
    },
    status() {
      const t = now()
      return {
        files: [...files.values()].map((f) => ({
          country: f.header.country,
          file: f.name,
          generatedAt: new Date(f.header.generatedAt * 1000).toISOString(),
          ageMin: Math.round((t - f.header.generatedAt * 1000) / 60000),
          usable: !gridTooOld(f.header, t),
        })),
        errors: [...errors],
        missing: [...missingNow],
        blockCache: { blocks: blockCache.size, bytes: blockCacheBytes },
      }
    },
    async close() {
      await Promise.all([...files.values(), ...retired].map((f) => f.close()))
      files = new Map()
      retired = []
    },
  }
}
