import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { watchView } from './mapDeclutter'

/** A map with just the events watchView listens to. */
function fakeMap() {
  const on: Record<string, ((e?: unknown) => void)[]> = {}
  return {
    map: { on: (n: string, f: () => void) => { (on[n] ??= []).push(f) }, off: (n: string, f: () => void) => { on[n] = (on[n] ?? []).filter(x => x !== f) } } as never,
    fire: (n: string, e?: unknown) => (on[n] ?? []).slice().forEach(f => f(e)),
    count: (n: string) => (on[n] ?? []).length,
  }
}

describe('watchView: when the declutter places the points again', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 16))
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('places once at the start, at most every 120 ms while the map moves, and right after it stops', () => {
    const again = vi.fn()
    const m = fakeMap()
    const stop = watchView(m.map, again, ['osm-landmarks'])
    expect(again).toHaveBeenCalledTimes(1)
    for (let t = 0; t < 600; t += 16) { vi.advanceTimersByTime(16); m.fire('move') }       // a zoom animation: a frame every 16 ms for 600 ms
    expect(again.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(again.mock.calls.length).toBeLessThanOrEqual(7)                                  // not on every frame
    const before = again.mock.calls.length
    m.fire('moveend')
    vi.advanceTimersByTime(20)
    expect(again).toHaveBeenCalledTimes(before + 1)                                         // the final placement follows the stop at once, not 250 ms later
    stop()
    expect(m.count('move') + m.count('moveend') + m.count('sourcedata')).toBe(0)
  })

  it('places shortly after a watched source loads, and not for another source or a partial load', () => {
    const again = vi.fn()
    const m = fakeMap()
    watchView(m.map, again, ['osm-landmarks'])
    again.mockClear()
    m.fire('sourcedata', { sourceId: 'own-position', isSourceLoaded: true })
    m.fire('sourcedata', { sourceId: 'osm-landmarks', isSourceLoaded: false })
    vi.advanceTimersByTime(500)
    expect(again).not.toHaveBeenCalled()
    m.fire('sourcedata', { sourceId: 'osm-landmarks', isSourceLoaded: true })
    vi.advanceTimersByTime(100)
    expect(again).toHaveBeenCalledTimes(1)
  })
})
