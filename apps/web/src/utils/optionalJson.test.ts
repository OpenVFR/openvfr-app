import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadOptionalJson } from './optionalJson'

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

afterEach(() => { vi.unstubAllGlobals() })

describe('loadOptionalJson', () => {
  it('remembers a 404 (the file is not published): one request only', async () => {
    const f = vi.fn(async () => new Response('', { status: 404 }))
    vi.stubGlobal('fetch', f)
    const cache = new Map<string, Promise<unknown>>()
    expect(await loadOptionalJson(cache, '/a.json', (x) => x)).toBeNull()
    expect(await loadOptionalJson(cache, '/a.json', (x) => x)).toBeNull()
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('does not remember a network failure: the next call tries again', async () => {
    const f = vi.fn()
      .mockRejectedValueOnce(new TypeError('offline')).mockRejectedValueOnce(new TypeError('offline')).mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValue(ok({ v: 1 }))
    vi.stubGlobal('fetch', f)
    const cache = new Map<string, Promise<unknown>>()
    expect(await loadOptionalJson(cache, '/b.json', (x) => x, )).toBeNull()      // retries inside, still failing
    expect(cache.has('/b.json')).toBe(false)
    expect(await loadOptionalJson(cache, '/b.json', (x) => x)).toEqual({ v: 1 })
    expect(cache.has('/b.json')).toBe(true)
  })

  it('does not remember a server error either', async () => {
    const f = vi.fn().mockResolvedValue(new Response('', { status: 500 }))
    vi.stubGlobal('fetch', f)
    const cache = new Map<string, Promise<unknown>>()
    expect(await loadOptionalJson(cache, '/c.json', (x) => x)).toBeNull()
    expect(cache.has('/c.json')).toBe(false)
  })
})
