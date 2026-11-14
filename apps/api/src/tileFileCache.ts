/**
 * In-memory cache of files the api reads from the tile host (TILES_BASE_URL), kept current through the host's
 * `manifest.json` the way the apps do it: each file is fetched by its versioned URL (`?v=<sha256 prefix>`) and fetched
 * again only when the manifest names a new hash. A data update (AIRAC cycle, obstacles) therefore reaches the api
 * within one manifest check instead of after a fixed TTL, and the versioned URL can be served from the edge cache.
 *
 * Cost, by design:
 * - No timer: the manifest is checked lazily, at most once per `manifestCheckMs`, and only when a file is asked for.
 *   One check is a few KB of JSON for all files together (shared by concurrent callers).
 * - One parsed copy per file. A file is downloaded and parsed again only when its hash changes, which is less often
 *   than the old fixed TTL refetch.
 * - A failed reload keeps the last good copy (and is retried after `retryMs`, not on every request).
 * - Without a usable manifest (unreachable, or the file is not listed) it falls back to the bare URL with the
 *   fixed `fallbackTtlMs`, the behaviour before this module.
 */
import { TILE_FETCH_HEADERS } from './tileFetch.js'

export interface TileFileCacheOptions<T> {
  baseUrl: string
  /** Fetch + parse one file; null = not available (logged by the caller). Must not throw. */
  load: (url: string) => Promise<T | null>
  /** Fixed lifetime of a copy loaded by its bare URL (no manifest entry). */
  fallbackTtlMs: number
  manifestCheckMs?: number
  retryMs?: number
  manifestTimeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}

type Hashes = Map<string, string>

interface Entry<T> {
  /** Content hash the value belongs to; null = loaded by the bare URL. */
  sha: string | null
  at: number
  value: Promise<T | null>
  /** The hash whose load failed last, and when (retry after retryMs). */
  failedSha?: string
  failedAt?: number
}

const SHA_RE = /^[0-9a-f]{64}$/

export function createTileFileCache<T>(opts: TileFileCacheOptions<T>) {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const manifestCheckMs = opts.manifestCheckMs ?? 5 * 60 * 1000
  const retryMs = opts.retryMs ?? 60 * 1000
  const manifestTimeoutMs = opts.manifestTimeoutMs ?? 10_000
  const cache = new Map<string, Entry<T>>()
  let lastGood: Hashes | null = null
  let check: { at: number; p: Promise<Hashes | null> } | null = null

  async function fetchManifest(): Promise<Hashes | null> {
    try {
      const res = await fetchImpl(`${opts.baseUrl}/manifest.json`, {
        headers: { ...TILE_FETCH_HEADERS, Accept: 'application/json' },
        signal: AbortSignal.timeout(manifestTimeoutMs),
      })
      if (!res.ok) { await res.body?.cancel().catch(() => undefined); return lastGood }
      const m = await res.json() as { files?: Record<string, { sha256?: unknown }> }
      const out: Hashes = new Map()
      for (const [name, e] of Object.entries(m?.files ?? {})) {
        if (typeof e?.sha256 === 'string' && SHA_RE.test(e.sha256)) out.set(name, e.sha256)
      }
      lastGood = out
      return out
    } catch {
      return lastGood                                                     // unreachable: keep the last known versions
    }
  }

  function hashes(): Promise<Hashes | null> {
    if (check && now() - check.at < manifestCheckMs) return check.p
    check = { at: now(), p: fetchManifest() }
    return check.p
  }

  async function get(name: string): Promise<T | null> {
    const sha = (await hashes())?.get(name) ?? null
    const cur = cache.get(name)

    if (!sha) {
      // Not versioned: the bare URL with a fixed lifetime (and keep a good copy if a refetch fails).
      if (cur && cur.sha === null && now() - cur.at < opts.fallbackTtlMs) return cur.value
      if (cur && cur.sha !== null) return cur.value                      // listed before, missing now: keep what we have
      const value = opts.load(`${opts.baseUrl}/${name}`)
      const entry: Entry<T> = { sha: null, at: now(), value }
      cache.set(name, entry)
      void value.then((v) => { if (v === null && cache.get(name) === entry) { if (cur) cache.set(name, cur); else cache.delete(name) } })
      return cur ? value.then(v => v ?? cur.value) : value
    }

    if (cur && cur.sha === sha) return cur.value
    if (cur && cur.failedSha === sha && now() - (cur.failedAt ?? 0) < retryMs) return cur.value

    const loading = opts.load(`${opts.baseUrl}/${name}?v=${sha.slice(0, 12)}`)
    // While the new version loads, concurrent callers share this load (the entry already carries the new hash).
    const entry: Entry<T> = { sha, at: now(), value: cur ? loading.then(v => v ?? cur.value) : loading }
    cache.set(name, entry)
    void loading.then((v) => {
      if (v !== null || cache.get(name) !== entry) return
      if (cur) cache.set(name, { ...cur, failedSha: sha, failedAt: now() })   // keep the last good copy
      else cache.delete(name)                                                // nothing to keep: next call retries
    })
    return entry.value
  }

  return { get }
}
