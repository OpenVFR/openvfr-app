import { describe, it, expect, vi } from 'vitest'
import {
  addTileKey, addTileKeyIfTileUrl, installTileKeyFetch, isUnderTileBase, parseTileKey, withTileKey,
} from './tileKey'

const KEY = 'k_0123456789abcdef'
const BASE = 'https://tiles.example.org'

describe('parseTileKey', () => {
  it('accepts a well-formed key and trims it', () => {
    expect(parseTileKey(`  ${KEY} `)).toBe(KEY)
  })
  it('treats unset and empty as no key', () => {
    expect(parseTileKey(undefined)).toBe('')
    expect(parseTileKey('')).toBe('')
  })
  it('ignores a malformed key and warns', () => {
    const warn = vi.fn()
    expect(parseTileKey('short', warn)).toBe('')
    expect(parseTileKey('has space in it 1234567', warn)).toBe('')
    expect(parseTileKey('a&b=c' + 'x'.repeat(20), warn)).toBe('')
    expect(warn).toHaveBeenCalledTimes(3)
  })
})

describe('isUnderTileBase', () => {
  it('matches files under the base', () => {
    expect(isUnderTileBase(`${BASE}/se-airspace.geojson`, BASE)).toBe(true)
    expect(isUnderTileBase(`${BASE}/wx/se/latest.json`, `${BASE}/`)).toBe(true)
    expect(isUnderTileBase(`${BASE}?x=1`, BASE)).toBe(true)
    expect(isUnderTileBase('HTTPS://TILES.example.org/a', BASE)).toBe(true)
  })
  it('does not match a look-alike host or path', () => {
    expect(isUnderTileBase('https://tiles.example.org.evil.com/a', BASE)).toBe(false)
    expect(isUnderTileBase('https://api.example.org/tiles/a', BASE)).toBe(false)
    expect(isUnderTileBase('http://localhost:5200/tilesx/a', 'http://localhost:5200/tiles')).toBe(false)
  })
  it('compares the path case-sensitively and refuses dot segments', () => {
    const base = 'https://api.example.org/tiles'
    expect(isUnderTileBase('https://API.example.org/tiles/a.json', base)).toBe(true)
    expect(isUnderTileBase('https://api.example.org/TILES/a.json', base)).toBe(false)
    expect(isUnderTileBase('https://api.example.org/tiles/../x', base)).toBe(false)
    expect(isUnderTileBase('https://api.example.org/tiles/./a.json', base)).toBe(false)
    expect(isUnderTileBase('https://api.example.org/tiles/%2e%2e/x', base)).toBe(false)
    expect(isUnderTileBase('https://api.example.org/tiles/a.json?next=../x', base)).toBe(true)
  })
  it('never matches a relative base', () => {
    expect(isUnderTileBase('/tiles/a.geojson', '/tiles')).toBe(false)
  })
})

describe('addTileKey', () => {
  it('adds the parameter with ? or &', () => {
    expect(addTileKey(`${BASE}/a.pmtiles`, KEY)).toBe(`${BASE}/a.pmtiles?ovk=${KEY}`)
    expect(addTileKey(`${BASE}/a.pmtiles?v=abc`, KEY)).toBe(`${BASE}/a.pmtiles?v=abc&ovk=${KEY}`)
    expect(addTileKey(`${BASE}/a.pmtiles?`, KEY)).toBe(`${BASE}/a.pmtiles?ovk=${KEY}`)
  })
  it('keeps a fragment last', () => {
    expect(addTileKey(`${BASE}/a.json?v=1#x`, KEY)).toBe(`${BASE}/a.json?v=1&ovk=${KEY}#x`)
  })
  it('is idempotent and a no-op without key', () => {
    const once = addTileKey(`${BASE}/a.geojson?v=1`, KEY)
    expect(addTileKey(once, KEY)).toBe(once)
    expect(addTileKey(`${BASE}/a.geojson`, '')).toBe(`${BASE}/a.geojson`)
  })
  it('does not mistake a longer parameter name for the key', () => {
    expect(addTileKey(`${BASE}/a?xovk=1`, KEY)).toBe(`${BASE}/a?xovk=1&ovk=${KEY}`)
  })
  it('works inside a pmtiles:// URL', () => {
    expect(`pmtiles://${addTileKey(`${BASE}/se-basemap.pmtiles?v=abc`, KEY)}`)
      .toBe(`pmtiles://${BASE}/se-basemap.pmtiles?v=abc&ovk=${KEY}`)
  })
})

describe('addTileKeyIfTileUrl', () => {
  it('only touches tile URLs', () => {
    expect(addTileKeyIfTileUrl(`${BASE}/a`, KEY, [BASE])).toBe(`${BASE}/a?ovk=${KEY}`)
    expect(addTileKeyIfTileUrl('https://api.example.org/health', KEY, [BASE])).toBe('https://api.example.org/health')
  })
})

describe('withTileKey', () => {
  it('returns the original fetch when unconfigured', () => {
    const f = vi.fn() as unknown as typeof fetch
    expect(withTileKey(f, '', [BASE])).toBe(f)
    expect(withTileKey(f, KEY, ['/tiles'])).toBe(f)
    expect(withTileKey(f, KEY, [])).toBe(f)
  })
  it('keys tile URLs (string, URL, Request) and passes others through', async () => {
    const seen: string[] = []
    const f = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return new Response('ok')
    }) as unknown as typeof fetch
    const kf = withTileKey(f, KEY, [BASE])
    await kf(`${BASE}/a.geojson?v=1`, { cache: 'no-store' })
    await kf(new URL(`${BASE}/b.pmtiles`))
    await kf(new Request(`${BASE}/c.json`, { headers: { Range: 'bytes=0-1' } }))
    await kf('https://other.example.org/x')
    expect(seen).toEqual([
      `${BASE}/a.geojson?v=1&ovk=${KEY}`,
      `${BASE}/b.pmtiles?ovk=${KEY}`,
      `${BASE}/c.json?ovk=${KEY}`,
      'https://other.example.org/x',
    ])
  })
  it('keeps the init (headers, signal) of a keyed call', async () => {
    const f = vi.fn(async () => new Response('ok')) as unknown as typeof fetch
    const init = { headers: { Range: 'bytes=0-15' } }
    await withTileKey(f, KEY, [BASE])(`${BASE}/a.pmtiles`, init)
    expect(f).toHaveBeenCalledWith(`${BASE}/a.pmtiles?ovk=${KEY}`, init)
  })
})

describe('withTileKey errors', () => {
  it('rejects instead of throwing synchronously when a Request cannot be rebuilt', async () => {
    const f = vi.fn(async () => new Response('ok')) as unknown as typeof fetch
    const req = new Request(`${BASE}/a.json`, { method: 'POST', body: 'x' })
    await req.text()   // body used: new Request(url, req) throws
    let thrown: unknown
    let promise: Promise<Response> | undefined
    try { promise = withTileKey(f, KEY, [BASE])(req) } catch (e) { thrown = e }
    expect(thrown).toBeUndefined()
    await expect(promise).rejects.toBeInstanceOf(TypeError)
  })
})

describe('installTileKeyFetch', () => {
  it('wraps once and not at all without key', async () => {
    const orig = vi.fn(async () => new Response('ok')) as unknown as typeof fetch
    const target = { fetch: orig }
    expect(installTileKeyFetch(target, '', [BASE])).toBe(false)
    expect(target.fetch).toBe(orig)
    expect(installTileKeyFetch(target, KEY, [BASE])).toBe(true)
    const first = target.fetch
    expect(installTileKeyFetch(target, KEY, [BASE])).toBe(false)
    expect(target.fetch).toBe(first)
    await target.fetch(`${BASE}/a`)
    expect(orig).toHaveBeenCalledWith(`${BASE}/a?ovk=${KEY}`, undefined)
  })
})
