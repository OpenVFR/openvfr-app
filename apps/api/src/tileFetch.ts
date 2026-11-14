/**
 * Headers for the api's own requests to the tile host (TILES_BASE_URL: datasets, manifest, charts indexes, grids). The api runs in a
 * datacenter: an anonymous request without a user agent looks like a bot to the tile host's edge, which may answer 403. Every other
 * outbound request of the api already names itself the same way.
 */
export const TILE_FETCH_HEADERS: Record<string, string> = { 'User-Agent': 'open-vfr/1.0 (api)' }

/** Upper bound for the tile host's manifest.json (a few KB per country in practice). */
export const TILE_MANIFEST_MAX_BYTES = 4 * 1024 * 1024
const SHA256_RE = /^[0-9a-f]{64}$/

type ErrorFactory = (message: string, status: number) => Error
const plainError: ErrorFactory = message => new Error(message)

/** A response body read whole, refused (error, reader cancelled) once it passes `maxBytes`: nothing oversized is buffered. */
export async function readCapped(res: Response, maxBytes: number, makeError: ErrorFactory = plainError): Promise<Uint8Array> {
  const len = Number(res.headers.get('content-length') ?? 'NaN')
  if (Number.isFinite(len) && len > maxBytes) throw makeError(`content-length ${len} over cap`, 413)
  if (!res.body) throw makeError('empty body', 502)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw makeError(`body over cap (${size} bytes read)`, 413)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(new ArrayBuffer(size))
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.byteLength }
  return out
}

/**
 * The tile host's manifest as file name -> sha256 (only well-formed 64-hex hashes), read with the size cap. The one
 * manifest reader of the api (briefing data, charts indexes); callers decide how long to share one result. Throws when
 * the manifest cannot be read.
 */
export async function fetchTileManifestHashes(
  baseUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; makeError?: ErrorFactory } = {},
): Promise<Map<string, string>> {
  const makeError = opts.makeError ?? plainError
  const url = `${baseUrl}/manifest.json`
  const res = await (opts.fetchImpl ?? fetch)(url, {
    headers: { ...TILE_FETCH_HEADERS, Accept: 'application/json' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  })
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined)
    throw makeError(`HTTP ${res.status} for ${url}`, 502)
  }
  const m = JSON.parse(new TextDecoder().decode(await readCapped(res, TILE_MANIFEST_MAX_BYTES, makeError))) as { files?: Record<string, { sha256?: unknown }> }
  const out = new Map<string, string>()
  for (const [name, e] of Object.entries(m?.files ?? {})) {
    if (typeof e?.sha256 === 'string' && SHA256_RE.test(e.sha256)) out.set(name, e.sha256)
  }
  return out
}
