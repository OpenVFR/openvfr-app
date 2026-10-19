/**
 * persistedCache — keeps selected in-memory caches across page reloads (web)
 * and app restarts (native).
 *
 * Why: the wind caches (fetchWind, windForecast) are what stops the apps from
 * calling Open-Meteo, whose free tier is rate limited per IP. Without this a
 * reload refetched every wind reading on screen even though the 30-minute
 * cache entries were still valid, and an outage right after a restart left
 * nothing to fall back on.
 *
 * Platform-free: a module registers its Map at load time
 * (registerPersistedCache); the app enables persistence once at startup with
 * its own storage (enableCachePersistence: `localStorage` on web,
 * AsyncStorage on native). Until then, and if storage fails, the caches are
 * simply in-memory as before. Entries must be JSON-serialisable and carry an
 * absolute `expiresAt` (epoch ms).
 */

export interface KeyValueStore {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
}

interface Registered {
  name: string
  map: Map<string, { expiresAt: number }>
  /** Keep entries this long past expiresAt (stale fallback window). */
  keepAfterExpiryMs: number
  /** Most entries written, newest expiry first (storage quota). */
  maxEntries: number
}

const STORAGE_PREFIX = 'openvfr.cache.'
/** Bump to drop all stored entries after a format change. */
const FORMAT = 1
const SAVE_DEBOUNCE_MS = 2000

const registry = new Map<string, Registered>()
let store: KeyValueStore | null = null
const dirty = new Set<string>()
let saveTimer: ReturnType<typeof setTimeout> | undefined

export function registerPersistedCache<V extends { expiresAt: number }>(
  name: string, map: Map<string, V>, opts: { keepAfterExpiryMs: number; maxEntries: number },
): void {
  registry.set(name, { name, map: map as Map<string, { expiresAt: number }>, ...opts })
}

/** Note that a registered cache changed; it is written shortly after. */
export function markCacheDirty(name: string): void {
  if (!store || !registry.has(name)) return
  dirty.add(name)
  if (saveTimer) return
  saveTimer = setTimeout(() => { saveTimer = undefined; void flush() }, SAVE_DEBOUNCE_MS)
}

/** Serialised form of a cache: live entries, newest expiry first, capped. Exported for tests. */
export function serializeCache(r: Pick<Registered, 'map' | 'keepAfterExpiryMs' | 'maxEntries'>, now: number): string {
  const entries = [...r.map.entries()]
    .filter(([, v]) => v.expiresAt + r.keepAfterExpiryMs > now)
    .sort((a, b) => b[1].expiresAt - a[1].expiresAt)
    .slice(0, r.maxEntries)
  return JSON.stringify({ v: FORMAT, entries })
}

/** Merge stored entries into `map` (never over a newer in-memory entry). Exported for tests. */
export function restoreCache(r: Pick<Registered, 'map' | 'keepAfterExpiryMs'>, raw: string | null, now: number): number {
  if (!raw) return 0
  let parsed: { v?: number; entries?: [string, { expiresAt: number }][] }
  try { parsed = JSON.parse(raw) } catch { return 0 }
  if (parsed.v !== FORMAT || !Array.isArray(parsed.entries)) return 0
  let n = 0
  for (const e of parsed.entries) {
    if (!Array.isArray(e) || typeof e[0] !== 'string' || typeof e[1]?.expiresAt !== 'number') continue
    const [key, value] = e
    if (value.expiresAt + r.keepAfterExpiryMs <= now) continue
    const cur = r.map.get(key)
    if (cur && cur.expiresAt >= value.expiresAt) continue
    r.map.set(key, value)
    n++
  }
  return n
}

async function flush(): Promise<void> {
  if (!store) return
  const names = [...dirty]
  dirty.clear()
  const now = Date.now()
  for (const name of names) {
    const r = registry.get(name)
    if (!r) continue
    try {
      await store.setItem(STORAGE_PREFIX + name, serializeCache(r, now))
    } catch {
      // Quota / storage error: the cache keeps working in memory.
    }
  }
}

/**
 * Load every registered cache from `kv` and write changes back from now on.
 * Call once at app startup, after importing the modules that own the caches
 * (they register at module load; a cache registered later is not restored).
 */
export async function enableCachePersistence(kv: KeyValueStore): Promise<void> {
  store = kv
  const now = Date.now()
  for (const r of registry.values()) {
    try {
      restoreCache(r, await kv.getItem(STORAGE_PREFIX + r.name), now)
    } catch {
      // Unreadable storage: start empty.
    }
  }
}
