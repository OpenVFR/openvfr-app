import { describe, it, expect } from 'vitest'
import { notamValidity, fmtUtcClock } from './notamValidity'

const now = Date.UTC(2026, 5, 10, 12, 0)
const iso = (h: number, m = 0, day = 10) => new Date(Date.UTC(2026, 5, day, h, m)).toISOString()

describe('notamValidity', () => {
  it('active inside window', () => expect(notamValidity(iso(10), iso(14), now)).toEqual({ state: 'active', label: 'Active' }))
  it('active with permanent/unknown end', () => expect(notamValidity(iso(10), null, now).state).toBe('active'))
  it('active with no start but future end', () => expect(notamValidity(null, iso(14), now).state).toBe('active'))
  it('upcoming within 24h shows countdown', () => {
    expect(notamValidity(iso(14, 15), iso(18), now).label).toBe('Starts in 2h 15m')
    expect(notamValidity(iso(12, 40), iso(18), now).label).toBe('Starts in 40m')
    expect(notamValidity(iso(15), iso(18), now).label).toBe('Starts in 3h')
  })
  it('upcoming beyond 24h', () => expect(notamValidity(iso(13, 0, 12), null, now)).toEqual({ state: 'upcoming', label: 'Upcoming' }))
  it('ended at/after end', () => {
    expect(notamValidity(iso(8), iso(12), now).state).toBe('ended')
    expect(notamValidity(iso(8), iso(11), now).label).toBe('Ended')
  })
  it('unknown when nothing parseable', () => {
    expect(notamValidity(null, null, now).state).toBe('unknown')
    expect(notamValidity('PERM', 'EST', now).state).toBe('unknown')
  })
})

describe('fmtUtcClock', () => {
  it('formats UTC', () => expect(fmtUtcClock(Date.UTC(2026, 0, 1, 7, 5))).toBe('07:05Z'))
})
