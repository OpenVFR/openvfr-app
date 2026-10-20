import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: { signal?: AbortSignal; resolve: (v: { distNm: number; elevFt: number }[]) => void; reject: (e: unknown) => void }[] = []
vi.mock('./virtualRadarCalc', () => ({
  fetchTerrainProfile: (_w: unknown, _b: unknown, signal?: AbortSignal) =>
    new Promise((resolve, reject) => {
      calls.push({ signal, resolve: resolve as never, reject })
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }),
}))

import { fetchTerrainProfileShared, clearTerrainCache } from './terrainCache'

const route = [{ lat: 60, lng: 15 }, { lat: 60.5, lng: 15.5 }]
const route2 = [{ lat: 61, lng: 15 }, { lat: 61.5, lng: 15.5 }]
const pts = [{ distNm: 0, elevFt: 10 }]

describe('fetchTerrainProfileShared', () => {
  beforeEach(() => { clearTerrainCache(); calls.length = 0 })

  it('one request for the same route, shared by all callers, reused afterwards', async () => {
    const a = fetchTerrainProfileShared(route)
    const b = fetchTerrainProfileShared([{ ...route[0] }, { ...route[1] }])
    expect(calls).toHaveLength(1)
    calls[0].resolve(pts)
    expect(await a).toBe(pts)
    expect(await b).toBe(pts)
    expect(await fetchTerrainProfileShared(route)).toBe(pts)   // from cache
    expect(calls).toHaveLength(1)
  })

  it('different routes are separate', () => {
    void fetchTerrainProfileShared(route).catch(() => {})
    void fetchTerrainProfileShared(route2).catch(() => {})
    expect(calls).toHaveLength(2)
  })

  it('aborts the request only when every caller has aborted', async () => {
    const c1 = new AbortController(), c2 = new AbortController()
    const a = fetchTerrainProfileShared(route, '', c1.signal)
    const b = fetchTerrainProfileShared(route, '', c2.signal)
    c1.abort()
    await expect(a).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls[0].signal!.aborted).toBe(false)          // c2 still waiting
    calls[0].resolve(pts)
    expect(await b).toBe(pts)
  })

  it('aborts the network request when the last caller leaves, and refetches next time', async () => {
    const c = new AbortController()
    const a = fetchTerrainProfileShared(route, '', c.signal)
    c.abort()
    await expect(a).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls[0].signal!.aborted).toBe(true)
    void fetchTerrainProfileShared(route).catch(() => {})
    expect(calls).toHaveLength(2)
  })

  it('does not cache a failure', async () => {
    const a = fetchTerrainProfileShared(route)
    calls[0].reject(new Error('boom'))
    await expect(a).rejects.toThrow('boom')
    void fetchTerrainProfileShared(route).catch(() => {})
    expect(calls).toHaveLength(2)
  })

  it('needs a route', async () => {
    expect(await fetchTerrainProfileShared([route[0]])).toEqual([])
    expect(calls).toHaveLength(0)
  })
})
