/**
 * demElevation — answers /api/elevation/ requests from this deployment's own
 * terrain archives (`<cc>-hillshade.pmtiles`: Copernicus GLO-30 as
 * Terrarium PNG raster-dem tiles, the same files the apps draw relief from),
 * so terrain does not depend on the public OpenTopoData budget (1 call/s,
 * 1 000/day for the whole server).
 *
 * Why on the server and not (only) in the apps: in flight the apps ask for
 * terrain many times an hour (live ground elevation under the aircraft, the
 * look-ahead profile that moves with it). Devices that have not downloaded
 * the large terrain archive have no local DEM, and reading the remote archive
 * from a phone risks a whole-archive response landing in its heap if the
 * tile host ever ignores Range (see AGENTS.md). Here a Range slip costs one
 * failed request on a server that refuses anything but a 206 of the size it
 * asked for.
 *
 * Accuracy: the archive's max zoom (10) is ~75-150 m per pixel, coarser than
 * OpenTopoData's 25 m. The proxy therefore still prefers OpenTopoData while
 * its budget lasts and uses this whenever upstream is throttled, over budget,
 * busy or failing, or the caller's own upstream quota is used up
 * (externalProxy.ts).
 *
 * Sources (env ELEVATION_DEM_SOURCES):
 *  - unset: `${TILES_BASE_URL}/<cc>-hillshade.pmtiles` for every country the
 *    registry lists as available (none when TILES_BASE_URL is unset);
 *  - `off`: disabled;
 *  - otherwise a comma-separated list of archive URLs (http/https) and/or
 *    absolute file paths.
 * The set is rebuilt every REFRESH_MS so rebuilt archives and newly enabled
 * countries are picked up; reads also carry the ETag so a mid-session
 * replacement is detected by pmtiles.
 */

import { open, type FileHandle } from 'node:fs/promises'
import { PmtilesDem, EtagMismatch, type RangeSource, type RangeResponse } from '@open-vfr/shared/terrainDem'
import { countryArchiveFile } from '@open-vfr/shared/countryData'

const REFRESH_MS = 60 * 60 * 1000
/** Decoded tiles kept per archive (128 KB each): ~25 MB per country at most. */
const SERVER_TILE_CACHE = 200
const RANGE_TIMEOUT_MS = 10_000
/** A PMTiles header/directory/tile read is at most a few hundred KB. */
const MAX_RANGE_BYTES = 4 * 1024 * 1024

/** Range reads over HTTP that refuse anything but a 206 of the requested size. Exported for tests. */
export class HttpRangeSource implements RangeSource {
  constructor(private readonly url: string, private readonly fetchImpl: typeof fetch = fetch) {}

  getKey(): string { return this.url }

  async getBytes(offset: number, length: number, signal?: AbortSignal, etag?: string): Promise<RangeResponse> {
    if (length > MAX_RANGE_BYTES) throw new Error(`dem: range of ${length} bytes refused`)
    const headers: Record<string, string> = { Range: `bytes=${offset}-${offset + length - 1}`, 'User-Agent': 'open-vfr/1.0' }
    const timeout = AbortSignal.timeout(RANGE_TIMEOUT_MS)
    const res = await this.fetchImpl(this.url, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    // The archive was replaced (rebuild): pmtiles drops its header and retries once.
    let newEtag = res.headers.get('ETag')
    if (newEtag?.startsWith('W/')) newEtag = null
    if (etag && newEtag && newEtag !== etag) {
      await res.body?.cancel().catch(() => {})
      throw new EtagMismatch(`dem: ${this.url} changed (ETag ${etag} -> ${newEtag})`)
    }
    // Anything but a slice (200 = the whole archive) is cancelled unread.
    const declared = Number(res.headers.get('Content-Length') ?? NaN)
    if (res.status !== 206 || (Number.isFinite(declared) && declared > length)) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`dem: ${this.url} answered HTTP ${res.status} (Content-Length ${res.headers.get('Content-Length') ?? '?'}) to a ${length}-byte Range request`)
    }
    // No Content-Length: read with a cap.
    const chunks: Uint8Array[] = []
    let total = 0
    const reader = res.body?.getReader()
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > length) { await reader.cancel().catch(() => {}); throw new Error(`dem: ${this.url} sent more than the ${length} bytes asked for`) }
        chunks.push(value)
      }
    }
    const data = new Uint8Array(total)
    let o = 0
    for (const c of chunks) { data.set(c, o); o += c.byteLength }
    return { data: data.buffer, etag: newEtag ?? undefined }
  }
}

/** Range reads from a local archive file. */
export class FileRangeSource implements RangeSource {
  private handle: Promise<FileHandle> | null = null

  constructor(private readonly path: string) {}

  getKey(): string { return this.path }

  /** One handle per archive, opened on first read and reopened after an error. */
  private fh(): Promise<FileHandle> {
    if (!this.handle) {
      const h = open(this.path, 'r')
      this.handle = h
      h.catch(() => { if (this.handle === h) this.handle = null })
    }
    return this.handle
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const fh = await this.fh()
    try {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await fh.read(buf, 0, length, offset)
      return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead) as ArrayBuffer }
    } catch (err) {
      await this.close()
      throw err
    }
  }

  async close(): Promise<void> {
    const h = this.handle
    this.handle = null
    if (h) await h.then((fh) => fh.close()).catch(() => {})
  }
}

/** What the proxy needs from a DEM: elevation in metres, `undefined` outside its coverage. */
export interface DemArchive {
  covers(lat: number, lng: number): Promise<boolean>
  elevationM(lat: number, lng: number): Promise<number | null>
}

/**
 * Elevations (metres) for the points, or null when any point lies outside
 * every archive or a read fails -- the caller then uses its other sources.
 * A covered point without data (sea, nodata) is null in the list, as in an
 * OpenTopoData answer. Exported for tests.
 */
export async function lookupPoints(dems: readonly DemArchive[], points: readonly { lat: number; lng: number }[]): Promise<(number | null)[] | null> {
  if (dems.length === 0) return null
  const out: (number | null)[] = []
  try {
    // Sequential: neighbouring samples share tiles, which the first read caches.
    for (const p of points) {
      let dem: DemArchive | undefined
      for (const d of dems) if (await d.covers(p.lat, p.lng)) { dem = d; break }
      if (!dem) return null
      out.push(await dem.elevationM(p.lat, p.lng))
    }
  } catch (err) {
    console.warn('[elevation-dem] read failed:', (err as Error)?.message)
    return null
  }
  return out
}

/** OpenTopoData-shaped answer (what the apps parse) for a `locations=lat,lng|...` query, or null. */
export async function demAnswer(dems: readonly DemArchive[], locations: string): Promise<string | null> {
  const points = locations.split('|').map((p) => { const [a, b] = p.split(','); return { lat: Number(a), lng: Number(b) } })
  const elev = await lookupPoints(dems, points)
  if (!elev) return null
  return JSON.stringify({
    results: points.map((p, i) => ({ dataset: 'dem', elevation: elev[i], location: { lat: p.lat, lng: p.lng } })),
    status: 'OK',
  })
}

/** Parses ELEVATION_DEM_SOURCES. Exported for tests. */
export function parseDemSources(v: string | undefined): 'auto' | 'off' | string[] {
  const s = (v ?? '').trim()
  if (s === '' || s.toLowerCase() === 'auto') return 'auto'
  if (s.toLowerCase() === 'off') return 'off'
  return s.split(',').map((x) => x.trim()).filter(Boolean)
}

/** One archive of the set: its DEM reader and the source behind it. */
export type Archive = { dem: PmtilesDem; source: HttpRangeSource | FileRangeSource }

function archiveFor(location: string): Archive {
  const source = /^https?:\/\//i.test(location) ? new HttpRangeSource(location) : new FileRangeSource(location)
  return { dem: new PmtilesDem(source, { cacheSize: SERVER_TILE_CACHE }), source }
}

/** Retry soon after a failed or partial build (registry or tile host down). */
const RETRY_MS = 2 * 60 * 1000

/**
 * The live DEM set. `countries` lists the available country codes (auto
 * mode). Returns the lookup the proxy calls; it never throws.
 *
 * Rebuilt every REFRESH_MS; after a failed or partial build (registry
 * unreadable, an archive header unreadable) every RETRY_MS instead -- never
 * per request. Archives whose location did not change are reused, keeping
 * their decoded tiles and pmtiles' directory cache (a replaced archive is
 * caught by its ETag). If every archive fails, the previous set stays.
 */
export function createDemElevation(opts: {
  sources: 'auto' | 'off' | string[]
  tilesBaseUrl: string
  countries: () => Promise<string[] | null>
  /** Archive factory (tests). */
  archive?: (location: string) => Archive
  now?: () => number
}): ((locations: string) => Promise<string | null>) | null {
  if (opts.sources === 'off') return null
  if (opts.sources === 'auto' && !opts.tilesBaseUrl) return null
  const now = opts.now ?? Date.now
  const make = opts.archive ?? archiveFor
  let inUse = new Map<string, Archive>()   // location -> archive, header readable
  let known = new Map<string, Archive>()   // every archive tried last time (reused on the next build)
  let built = false
  let nextBuildAt = 0
  let building: Promise<void> | null = null
  const rebuild = async () => {
    let locations: string[]
    if (opts.sources === 'auto') {
      const codes = await opts.countries().catch(() => null)
      if (!codes) {
        // Registry unreadable: keep the current set, try again soon.
        nextBuildAt = now() + RETRY_MS
        return
      }
      locations = codes.map((c) => `${opts.tilesBaseUrl}/${countryArchiveFile(c, 'hillshade')}`)
    } else {
      locations = opts.sources as string[]
    }
    const next = new Map(locations.map((l) => [l, known.get(l) ?? make(l)] as const))
    // Keep only archives whose header can be read (missing country file, host down).
    const ok = await Promise.all([...next].map(([l, a]) => a.dem.ready().then(() => true, (err: unknown) => {
      console.warn(`[elevation-dem] archive unavailable (${l}):`, (err as Error)?.message)
      return false
    })))
    const usable = new Map([...next].filter((_, i) => ok[i]))
    // Archives no longer listed: release their file handles.
    for (const [l, a] of known) if (!next.has(l) && a.source instanceof FileRangeSource) void a.source.close()
    known = next
    if (usable.size === 0 && inUse.size > 0) {
      console.warn('[elevation-dem] no archive readable; keeping the previous set')
    } else {
      inUse = usable
      console.log(`[elevation-dem] ${usable.size} of ${locations.length} terrain archive(s) in use`)
    }
    built = true
    nextBuildAt = now() + (usable.size < locations.length ? RETRY_MS : REFRESH_MS)
  }
  const ensure = async () => {
    if (now() < nextBuildAt) return
    building ??= rebuild().finally(() => { building = null })
    // First build: wait for it. Later refreshes: keep answering from the current set.
    if (!built) await building
  }
  return async (locations) => {
    await ensure().catch(() => {})
    return demAnswer([...inUse.values()].map((a) => a.dem), locations)
  }
}
