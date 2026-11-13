// packages/shared/src/tileKey.ts
//
// Optional access key for the tile host, sent as the query parameter
// `ovk=<key>` by clients that have no browser Origin: the native app, the
// api server, dev proxies. A deployment can then let its tile host answer
// only (a) browser requests from its own web origins and (b) requests that
// carry a key, so other apps can't simply point at the tile host. The rule
// itself lives at the CDN / host (not in this repo); with no key configured
// nothing here changes any request.
//
// Why a query parameter and not a header:
//   - MapLibre Native fetches PMTiles ranges and GeoJSON sources itself. A
//     URL built in JS reaches it unchanged on Android and iOS; a header would
//     need native request hooks (on Android, maplibre-react-native's own hook
//     replaces the app's OkHttp client and logs every request to JS).
//   - A custom header on a cross-origin browser request forces a CORS
//     preflight; a query parameter does not.
//   - Object storage ignores unknown query parameters (`?v=` already relies
//     on that, see ./tileManifest.ts).
//
// The key is NOT a secret: it ships inside the app and can be extracted. It
// only stops casual reuse of the tile host and can be rotated.
//
// Never configure a key in a web build: the web app is identified by its
// Origin, and a key in a public bundle would be readable by anyone.

/** Query parameter name. Keep in sync with the tile host's access rule. */
export const TILE_KEY_PARAM = 'ovk'

/** Characters allowed in a key: URL-safe without encoding, 16-128 long. */
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/

/** The key from an env value, or '' when unset or malformed (malformed = warned once, then ignored). */
export function parseTileKey(raw: string | undefined | null, warn: (msg: string) => void = () => {}): string {
  const key = (raw ?? '').trim()
  if (!key) return ''
  if (!KEY_RE.test(key)) {
    warn(`tile key ignored: must be 16-128 characters of A-Z a-z 0-9 _ - (got ${key.length} characters)`)
    return ''
  }
  return key
}

/** Absolute http(s) base without trailing slash, or null (relative bases such as '/tiles' never get a key). */
function normaliseBase(base: string): string | null {
  const b = base.trim().replace(/\/+$/, '')
  return /^https?:\/\/[^/?#]+/i.test(b) ? b : null
}

/** True when `url` points at a file under `base` (prefix match on whole path segments, case-insensitive host). */
export function isUnderTileBase(url: string, base: string): boolean {
  const b = normaliseBase(base)
  if (!b) return false
  const u = url.slice(0, b.length).toLowerCase()
  if (u !== b.toLowerCase()) return false
  const next = url.charAt(b.length)
  return next === '' || next === '/' || next === '?' || next === '#'
}

/** `url` with `ovk=<key>` added (before any #fragment). Unchanged when the key is empty or the URL already has the parameter. */
export function addTileKey(url: string, key: string): string {
  if (!key) return url
  const hashAt = url.indexOf('#')
  const main = hashAt === -1 ? url : url.slice(0, hashAt)
  const frag = hashAt === -1 ? '' : url.slice(hashAt)
  const q = main.indexOf('?')
  if (q !== -1 && new RegExp(`[?&]${TILE_KEY_PARAM}=`).test(main.slice(q))) return url
  const sep = q === -1 ? '?' : (main.endsWith('?') || main.endsWith('&') ? '' : '&')
  return `${main}${sep}${TILE_KEY_PARAM}=${key}${frag}`
}

/** addTileKey, but only for URLs under one of `bases`. */
export function addTileKeyIfTileUrl(url: string, key: string, bases: readonly string[]): string {
  if (!key) return url
  return bases.some((b) => isUnderTileBase(url, b)) ? addTileKey(url, key) : url
}

type FetchFn = typeof fetch

/**
 * A fetch that adds the key to every request for a URL under one of `bases`
 * and passes everything else through untouched. Returns `fetchImpl` itself
 * when there is no key or no absolute base, so an unconfigured deployment
 * runs exactly the code it ran before.
 */
export function withTileKey(fetchImpl: FetchFn, key: string, bases: readonly string[]): FetchFn {
  const abs = bases.map(normaliseBase).filter((b): b is string => b !== null)
  if (!key || abs.length === 0) return fetchImpl
  const wrapped = (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    if (typeof input === 'string') return fetchImpl(addTileKeyIfTileUrl(input, key, abs), init)
    if (typeof URL !== 'undefined' && input instanceof URL) return fetchImpl(addTileKeyIfTileUrl(input.href, key, abs), init)
    // Request object: rebuild it only when the URL changes (keeps method, headers, body, signal).
    const req = input as Request
    const next = addTileKeyIfTileUrl(req.url, key, abs)
    return fetchImpl(next === req.url ? req : new Request(next, req), init)
  }
  return wrapped as FetchFn
}

const INSTALLED = Symbol.for('openvfr.tileKeyFetch')

/**
 * Replaces `target.fetch` (normally globalThis) with withTileKey(...), once.
 * Call it at process / app start, before anything fetches from the tile host.
 * Returns true when a wrapper was installed.
 */
export function installTileKeyFetch(target: { fetch: FetchFn }, key: string, bases: readonly string[]): boolean {
  const t = target as { fetch: FetchFn } & { [INSTALLED]?: boolean }
  if (t[INSTALLED]) return false
  const original = t.fetch
  const wrapped = withTileKey(original, key, bases)
  if (wrapped === original) return false
  t.fetch = wrapped
  t[INSTALLED] = true
  return true
}
