import { describe, it, expect, vi, afterEach } from 'vitest'
import { serializeCache, restoreCache, registerPersistedCache, enableCachePersistence, markCacheDirty } from './persistedCache'

const NOW = 1_800_000_000_000

describe('serializeCache / restoreCache', () => {
  it('round-trips live entries, drops ones past the stale window, caps newest first', () => {
    const map = new Map([
      ['old', { expiresAt: NOW - 5 * 3600_000, v: 1 }],     // past the 3 h window
      ['stale', { expiresAt: NOW - 3600_000, v: 2 }],       // expired, still usable
      ['a', { expiresAt: NOW + 1000, v: 3 }],
      ['b', { expiresAt: NOW + 2000, v: 4 }],
    ])
    const raw = serializeCache({ map, keepAfterExpiryMs: 3 * 3600_000, maxEntries: 2 }, NOW)
    const out = new Map<string, { expiresAt: number }>()
    expect(restoreCache({ map: out, keepAfterExpiryMs: 3 * 3600_000 }, raw, NOW)).toBe(2)
    expect([...out.keys()]).toEqual(['b', 'a'])
  })

  it('never overwrites a newer in-memory entry and ignores garbage', () => {
    const out = new Map([['k', { expiresAt: NOW + 5000, v: 'mem' }]])
    const raw = JSON.stringify({ v: 1, entries: [['k', { expiresAt: NOW + 1000, v: 'disk' }], ['x', 'bad'], [1, {}]] })
    expect(restoreCache({ map: out, keepAfterExpiryMs: 0 }, raw, NOW)).toBe(0)
    expect(out.get('k')).toEqual({ expiresAt: NOW + 5000, v: 'mem' })
    expect(restoreCache({ map: out, keepAfterExpiryMs: 0 }, '{not json', NOW)).toBe(0)
    expect(restoreCache({ map: out, keepAfterExpiryMs: 0 }, JSON.stringify({ v: 99, entries: [] }), NOW)).toBe(0)
  })
})

describe('enableCachePersistence', () => {
  afterEach(() => { vi.useRealTimers() })

  it('restores at startup and writes changes back, debounced', async () => {
    vi.useFakeTimers()
    const store = new Map<string, string>()
    const map = new Map<string, { expiresAt: number; v: number }>()
    registerPersistedCache('t1', map, { keepAfterExpiryMs: 0, maxEntries: 10 })
    store.set('openvfr.cache.t1', JSON.stringify({ v: 1, entries: [['k', { expiresAt: Date.now() + 60_000, v: 7 }]] }))
    const kv = { getItem: (k: string) => store.get(k) ?? null, setItem: vi.fn((k: string, v: string) => { store.set(k, v) }) }
    await enableCachePersistence(kv)
    expect(map.get('k')?.v).toBe(7)

    map.set('n', { expiresAt: Date.now() + 60_000, v: 8 })
    markCacheDirty('t1')
    markCacheDirty('t1')
    expect(kv.setItem).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2500)
    expect(kv.setItem).toHaveBeenCalledTimes(1)
    expect(JSON.parse(store.get('openvfr.cache.t1')!).entries.map((e: [string]) => e[0]).sort()).toEqual(['k', 'n'])
  })

  it('keeps working in memory when storage throws', async () => {
    const map = new Map<string, { expiresAt: number }>()
    registerPersistedCache('t2', map, { keepAfterExpiryMs: 0, maxEntries: 10 })
    await expect(enableCachePersistence({
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('quota') },
    })).resolves.toBeUndefined()
  })
})
