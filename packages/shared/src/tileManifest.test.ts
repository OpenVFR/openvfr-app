import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Mod = typeof import('./tileManifest')

const BASE = 'https://tiles.example.org'
const manifest = (hash: string) => ({
  generated_at: '2026-11-13T00:00:00Z',
  countries: {},
  files: { 'se-airspace.geojson': { sha256: hash.repeat(64 / hash.length), bytes: 10 } },
})

/** A fetch whose manifest response the test resolves (or fails) by hand. */
function deferredFetch() {
  const calls: string[] = []
  let respond: (body: unknown) => void = () => {}
  let fail: () => void = () => {}
  const fetchMock = vi.fn((url: string) => {
    calls.push(url)
    return new Promise<Response>((resolve, reject) => {
      respond = (body) => resolve({ ok: true, json: async () => body } as Response)
      fail = () => reject(new Error('offline'))
    })
  })
  return { fetchMock, calls, respond: (b: unknown) => respond(b), fail: () => fail() }
}

let mod: Mod
beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  mod = await import('./tileManifest')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('versionedTileUrlReady', () => {
  it('returns the versioned URL once the manifest resolves, even when asked before it', async () => {
    const f = deferredFetch()
    vi.stubGlobal('fetch', f.fetchMock)
    mod.loadTileManifest(BASE)
    expect(mod.versionedTileUrl(BASE, 'se-airspace.geojson')).toBe(`${BASE}/se-airspace.geojson`) // sync: not yet
    const p = mod.versionedTileUrlReady(BASE, 'se-airspace.geojson')
    f.respond(manifest('ab'))
    expect(await p).toBe(`${BASE}/se-airspace.geojson?v=${'ab'.repeat(6)}`)
    expect(f.calls).toEqual([`${BASE}/manifest.json`])
  })

  it('falls back to the unversioned URL after the timeout, and does not wait again for the same load', async () => {
    const f = deferredFetch()
    vi.stubGlobal('fetch', f.fetchMock)
    const p = mod.versionedTileUrlReady(BASE, 'se-airspace.geojson', 3000)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await p).toBe(`${BASE}/se-airspace.geojson`)
    // Later callers do not pay the timeout again while the manifest is still missing.
    let resolved = false
    void mod.versionedTileUrlReady(BASE, 'se-airspace.geojson', 3000).then(() => { resolved = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(true)
  })

  it('falls back to the unversioned URL when the manifest fails to load', async () => {
    const f = deferredFetch()
    vi.stubGlobal('fetch', f.fetchMock)
    const p = mod.versionedTileUrlReady(BASE, 'se-airspace.geojson')
    f.fail()
    expect(await p).toBe(`${BASE}/se-airspace.geojson`)
  })

  it('keeps a file the manifest does not list unversioned (optional file, 404 path)', async () => {
    const f = deferredFetch()
    vi.stubGlobal('fetch', f.fetchMock)
    const p = mod.versionedTileUrlReady(BASE, 'se-aerodrome-details.geojson')
    f.respond(manifest('ab'))
    expect(await p).toBe(`${BASE}/se-aerodrome-details.geojson`)
  })

  it('does not wait when a manifest is already known, even during a refetch', async () => {
    const f = deferredFetch()
    vi.stubGlobal('fetch', f.fetchMock)
    const first = mod.loadTileManifest(BASE)
    f.respond(manifest('ab'))
    await first
    void mod.refreshTileManifest(BASE) // left pending
    let url = ''
    void mod.versionedTileUrlReady(BASE, 'se-airspace.geojson').then((u) => { url = u })
    await vi.advanceTimersByTimeAsync(0)
    expect(url).toBe(`${BASE}/se-airspace.geojson?v=${'ab'.repeat(6)}`)
  })

  it('keeps the known manifest when a refetch fails', async () => {
    const f = deferredFetch()
    vi.stubGlobal('fetch', f.fetchMock)
    const first = mod.loadTileManifest(BASE)
    f.respond(manifest('ab'))
    await first
    const again = mod.refreshTileManifest(BASE)
    f.fail()
    await again
    expect(mod.versionedTileUrl(BASE, 'se-airspace.geojson')).toBe(`${BASE}/se-airspace.geojson?v=${'ab'.repeat(6)}`)
  })
})

describe('change listeners and the unversioned fallback', () => {
  it('fire when the first manifest arrives after a caller went on without one', async () => {
    const f = deferredFetch()
    vi.stubGlobal('fetch', f.fetchMock)
    const seen = vi.fn()
    mod.onTileManifestChanged(seen)
    const early = mod.versionedTileUrlReady(BASE, 'se-airspace.geojson', 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await early).toBe(`${BASE}/se-airspace.geojson`)
    f.respond(manifest('ab'))
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen).toHaveBeenCalledWith('versioned')
  })

  it('do not fire on a normal start where every caller got the manifest', async () => {
    const f = deferredFetch()
    vi.stubGlobal('fetch', f.fetchMock)
    const seen = vi.fn()
    mod.onTileManifestChanged(seen)
    const p = mod.versionedTileUrlReady(BASE, 'se-airspace.geojson')
    // A synchronous URL built before the manifest (a cache key, not a fetch) must not count as a fallback.
    mod.versionedTileUrl(BASE, 'se-airspace.geojson')
    f.respond(manifest('ab'))
    await p
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).not.toHaveBeenCalled()
  })
})

describe('stored manifest (offline start)', () => {
  const memStore = (init?: string) => {
    const m = new Map<string, string>()
    if (init) m.set('ovfr:tile-manifest:v1', init)
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, m }
  }

  it('keeps a fetched manifest and uses it when the next start is offline', async () => {
    const store = memStore()
    let f = deferredFetch()
    vi.stubGlobal('fetch', f.fetchMock)
    mod.enableTileManifestPersistence(store)
    const p = mod.loadTileManifest(BASE)
    f.respond(manifest('ab'))
    await p
    expect(store.m.size).toBe(1)

    vi.resetModules()
    mod = await import('./tileManifest')
    f = deferredFetch()
    vi.stubGlobal('fetch', f.fetchMock)
    mod.enableTileManifestPersistence(store)
    const url = mod.versionedTileUrlReady(BASE, 'se-airspace.geojson')
    f.fail()
    expect(await url).toBe(`${BASE}/se-airspace.geojson?v=${'ab'.repeat(6)}`)
    expect(mod.isTileManifestFromStorage()).toBe(true)
  })

  it('uses the stored copy when the network wait times out, and fires listeners when the fresh one differs', async () => {
    const store = memStore(JSON.stringify({ base: BASE, manifest: manifest('ab') }))
    const f = deferredFetch()
    vi.stubGlobal('fetch', f.fetchMock)
    mod.enableTileManifestPersistence(store)
    const seen = vi.fn()
    mod.onTileManifestChanged(seen)
    const url = mod.versionedTileUrlReady(BASE, 'se-airspace.geojson', 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await url).toBe(`${BASE}/se-airspace.geojson?v=${'ab'.repeat(6)}`)
    f.respond(manifest('cd'))
    await vi.advanceTimersByTimeAsync(0)
    expect(mod.versionedTileUrl(BASE, 'se-airspace.geojson')).toBe(`${BASE}/se-airspace.geojson?v=${'cd'.repeat(6)}`)
    expect(mod.isTileManifestFromStorage()).toBe(false)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen).toHaveBeenCalledWith('update')
  })

  it('ignores a stored manifest of another tile host', async () => {
    const store = memStore(JSON.stringify({ base: 'https://other.example.org', manifest: manifest('ab') }))
    const f = deferredFetch()
    vi.stubGlobal('fetch', f.fetchMock)
    mod.enableTileManifestPersistence(store)
    const url = mod.versionedTileUrlReady(BASE, 'se-airspace.geojson')
    f.fail()
    expect(await url).toBe(`${BASE}/se-airspace.geojson`)
  })
})

describe('robustness', () => {
  it('ignores an older load that finishes after a refresh started a newer one', async () => {
    const responders: Array<(b: unknown) => void> = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      responders.push((b) => resolve({ ok: true, json: async () => b } as Response))
    })))
    const first = mod.loadTileManifest(BASE)
    const second = mod.refreshTileManifest(BASE)
    responders[1]!(manifest('cd'))
    await second
    responders[0]!(manifest('ab'))
    await first
    expect(mod.versionedTileUrl(BASE, 'se-airspace.geojson')).toBe(`${BASE}/se-airspace.geojson?v=${'cd'.repeat(6)}`)
  })

  it('drops entries without a valid sha256 instead of failing in every URL builder', async () => {
    const f = deferredFetch()
    vi.stubGlobal('fetch', f.fetchMock)
    const p = mod.loadTileManifest(BASE)
    f.respond({ files: { 'a.geojson': { sha256: 42 }, 'b.geojson': { sha256: 'x&y=1' }, 'se-airspace.geojson': { sha256: 'ab'.repeat(32), bytes: 1 } } })
    await p
    expect(mod.versionedTileUrl(BASE, 'a.geojson')).toBe(`${BASE}/a.geojson`)
    expect(mod.versionedTileUrl(BASE, 'b.geojson')).toBe(`${BASE}/b.geojson`)
    expect(mod.versionedTileUrl(BASE, 'se-airspace.geojson')).toBe(`${BASE}/se-airspace.geojson?v=${'ab'.repeat(6)}`)
  })

  it('a refresh that names other content notifies `update`, an identical one does not', async () => {
    let f = deferredFetch()
    vi.stubGlobal('fetch', f.fetchMock)
    const seen = vi.fn()
    mod.onTileManifestChanged(seen)
    let p = mod.loadTileManifest(BASE); f.respond(manifest('ab')); await p
    f = deferredFetch(); vi.stubGlobal('fetch', f.fetchMock)
    p = mod.refreshTileManifest(BASE); f.respond(manifest('ab')); await p
    expect(seen).not.toHaveBeenCalled()
    f = deferredFetch(); vi.stubGlobal('fetch', f.fetchMock)
    p = mod.refreshTileManifest(BASE); f.respond(manifest('cd')); await p
    expect(seen).toHaveBeenCalledWith('update')
  })

  it('shares one wait (and one storage read) between concurrent callers, and uses a stored copy after the short grace', async () => {
    const getItem = vi.fn(() => JSON.stringify({ base: BASE, manifest: manifest('ab') }))
    vi.stubGlobal('fetch', deferredFetch().fetchMock)            // never answers
    mod.enableTileManifestPersistence({ getItem, setItem: () => {} })
    const urls = Promise.all(Array.from({ length: 20 }, () => mod.versionedTileUrlReady(BASE, 'se-airspace.geojson')))
    await vi.advanceTimersByTimeAsync(1000)                      // grace, well before the 3 s timeout
    expect(new Set(await urls)).toEqual(new Set([`${BASE}/se-airspace.geojson?v=${'ab'.repeat(6)}`]))
    expect(getItem).toHaveBeenCalledTimes(1)
  })

  it('rejects a stored manifest with invalid entries', async () => {
    const store = { getItem: () => JSON.stringify({ base: BASE, manifest: { files: { 'se-airspace.geojson': { sha256: null } } } }), setItem: () => {} }
    const f = deferredFetch()
    vi.stubGlobal('fetch', f.fetchMock)
    mod.enableTileManifestPersistence(store)
    const url = mod.versionedTileUrlReady(BASE, 'se-airspace.geojson')
    f.fail()
    expect(await url).toBe(`${BASE}/se-airspace.geojson`)
  })
})
