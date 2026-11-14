/**
 * In-memory cache of files the api reads from the tile host (TILES_BASE_URL), kept current through the host's
 * `manifest.json` the way the apps do it: each file is fetched by its versioned URL (`?v=<sha256 prefix>`) and fetched
 * again only when the manifest names a new hash. A data update (AIRAC cycle, obstacles) therefore reaches the api
 * within one manifest check instead of after a fixed TTL, and the versioned URL can be served from the edge cache.
 *
 * Cost, by design:
 * - No timer: the manifest is checked lazily, at most once per `manifestCheckMs`, and only when a file is asked for.
 *   A cached file is returned at once and the manifest is revalidated in the background (stale-while-revalidate): a
 *   request waits for the manifest only when the file is not cached yet. One check is a few KB for all files together,
 *   size-capped, shared by concurrent callers (tileFetch.fetchTileManifestHashes, the api's one manifest reader).
 * - One parsed copy per file. A file is downloaded and parsed again only when its hash changes.
 * - A failed load keeps the last good copy, which every caller gets (also concurrent ones); the load is retried after
 *   `retryMs`, not on every request. Without a good copy, callers get null quickly until then.
 * - A file without a manifest entry (manifest unreachable, file not listed, or no longer listed) is loaded by its bare
 *   URL and reloaded after `fallbackTtlMs`, keeping the old copy if that reload fails.
 */
import { fetchTileManifestHashes } from './tileFetch.js'

export interface TileFileCacheOptions<T> {
  baseUrl: string
  /** Fetch + parse one file; null = not available (logged by the caller). Must not throw. */
  load: (url: string) => Promise<T | null>
  /** Lifetime of a copy loaded by its bare URL (no manifest entry). */
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
  /** When this version was loaded (lifetime of bare-URL copies). */
  at: number
  /** Resolves to the loaded value, or to the previous good copy if this load failed. */
  value: Promise<T | null>
}

export function createTileFileCache<T>(opts: TileFileCacheOptions<T>) {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const manifestCheckMs = opts.manifestCheckMs ?? 5 * 60 * 1000
  const retryMs = opts.retryMs ?? 60 * 1000
  const manifestTimeoutMs = opts.manifestTimeoutMs ?? 10_000
  const cache = new Map<string, Entry<T>>()
  /** The last load that failed per file: which version (sha or null) and when. */
  const failures = new Map<string, { sha: string | null; at: number }>()
  let lastGood: Hashes | null = null
  let check: { at: number; p: Promise<Hashes | null> } | null = null

  function hashes(): Promise<Hashes | null> {
    if (check && now() - check.at < manifestCheckMs) return check.p
    const p = fetchTileManifestHashes(opts.baseUrl, { fetchImpl, timeoutMs: manifestTimeoutMs })
      .then((h) => { lastGood = h; return h })
      .catch(() => lastGood)                                         // unreachable: keep the last known versions
    check = { at: now(), p }
    return p
  }

  async function get(name: string): Promise<T | null> {
    let h: Hashes | null
    if (cache.has(name)) {
      h = lastGood                                                   // null = no manifest known: bare-URL rules below
      void hashes()                                                  // revalidate in the background when due
    } else {
      h = await hashes()
    }
    // Read after the await: a concurrent caller may have started this load meanwhile (it is then shared).
    const cur = cache.get(name)
    const sha = h?.get(name) ?? null

    // Fresh: the same version, or a bare-URL copy (also one whose manifest entry disappeared) within its lifetime.
    if (cur && (sha !== null ? cur.sha === sha : now() - cur.at < opts.fallbackTtlMs)) return cur.value

    const failed = failures.get(name)
    if (failed && failed.sha === sha && now() - failed.at < retryMs) return cur ? cur.value : null

    const url = sha !== null ? `${opts.baseUrl}/${name}?v=${sha.slice(0, 12)}` : `${opts.baseUrl}/${name}`
    const loading = opts.load(url)
    // Concurrent callers share this load and, if it fails, get the previous good copy like the first caller.
    const entry: Entry<T> = { sha, at: now(), value: loading.then(v => (v !== null ? v : cur ? cur.value : null)) }
    cache.set(name, entry)
    void loading.then((v) => {
      if (cache.get(name) !== entry) return
      if (v !== null) { failures.delete(name); return }
      failures.set(name, { sha, at: now() })
      if (cur) cache.set(name, cur)                                  // keep the last good copy (its own version and age)
      else cache.delete(name)
    })
    return entry.value
  }

  return { get }
}
