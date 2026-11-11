import { describe, it, expect } from 'vitest'
import { isNewNotam, sortNewestFirst } from './notamAge'

const n = (id: string, issued: string | null, effective: string | null = null) =>
  ({ id, effective, icao: issued ? { issued } : null })
const now = Date.parse('2026-11-10T12:00:00Z')

describe('notamAge', () => {
  it('new = issued within 12 hours', () => {
    expect(isNewNotam(n('a', '2026-11-10T03:00:00Z'), now)).toBe(true)
    expect(isNewNotam(n('a', '2026-11-09T23:00:00Z'), now)).toBe(false)
    expect(isNewNotam(n('a', null, '2026-11-10T11:00:00Z'), now)).toBe(false)
    expect(isNewNotam(n('a', 'garbage'), now)).toBe(false)
  })
  it('newest first, stable, falls back to validity start', () => {
    const list = [n('old', '2026-11-01T00:00:00Z'), n('x', null, '2026-11-05T00:00:00Z'), n('new', '2026-11-09T00:00:00Z'), n('y', null, '2026-11-05T00:00:00Z')]
    expect(sortNewestFirst(list).map((v) => v.id)).toEqual(['new', 'x', 'y', 'old'])
  })
})
