import { describe, it, expect } from 'vitest'
import { notamValidity, notamStatus, fmtUtcClock } from './notamValidity'

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

describe('notamStatus with a schedule', () => {
  const n = {
    text: 'TEMPORARY RESTRICTED AREA ACT', effective: '2026-11-01T00:00:00Z', expires: '2026-11-30T00:00:00Z',
    icao: { schedule: 'MON-FRI 1000-1400' }, lat: 59.65, lon: 17.93,
  }
  it('in force inside the schedule', () => {
    expect(notamStatus(n, Date.parse('2026-11-10T12:00:00Z')).state).toBe('active')
  })
  it('off schedule says when it next applies', () => {
    const v = notamStatus(n, Date.parse('2026-11-10T15:00:00Z'))
    expect(v.state).toBe('scheduled')
    expect(v.label).toBe('Off schedule · next Wed 10:00Z')
  })
  it('same-day next start has no weekday', () => {
    const v = notamStatus(n, Date.parse('2026-11-10T08:00:00Z'))
    expect(v.label).toBe('Off schedule · next 10:00Z')
  })
})
