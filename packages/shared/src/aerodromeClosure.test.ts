import { describe, it, expect } from 'vitest'
import type { NotamItem } from './fetchNotam'
import { aerodromeClosure, closureLabel, isAerodromeClosureNotam } from './aerodromeClosure'

const AD = { lat: 59.65, lon: 17.93 }
const at = (iso: string) => Date.parse(iso)

function notam(over: Partial<NotamItem> & { schedule?: string | null; estimated?: boolean }): NotamItem {
  const { schedule = null, estimated = false, ...rest } = over
  return {
    id: 'A1/26', nmsId: 'x', text: 'AD CLSD', effective: '2026-11-01T00:00:00Z', expires: '2026-11-30T00:00:00Z',
    classification: null, icaoLocation: 'ESSA', qCode: 'QFALC', polygon: null, lat: 59.65, lon: 17.93, radiusNm: 5,
    icao: { schedule, estimated } as NotamItem['icao'],
    ...rest,
  } as NotamItem
}

describe('isAerodromeClosureNotam', () => {
  it('Q-code FA+LC', () => expect(isAerodromeClosureNotam({ qCode: 'QFALC', text: 'ANY' })).toBe(true))
  it('runway closure is not an aerodrome closure', () => {
    expect(isAerodromeClosureNotam({ qCode: 'QMRLC', text: 'RWY 01/19 CLSD' })).toBe(false)
    expect(isAerodromeClosureNotam({ qCode: 'QMRLC', text: 'AD CLSD' })).toBe(false)
  })
  it('text fallback without a Q-code', () => {
    expect(isAerodromeClosureNotam({ qCode: null, text: 'AERODROME CLOSED DUE TO SNOW' })).toBe(true)
    expect(isAerodromeClosureNotam({ qCode: null, text: 'RWY 01 CLSD' })).toBe(false)
  })
  it('cancelled/withdrawn is not a closure', () => {
    expect(isAerodromeClosureNotam({ qCode: 'QFAXX', text: 'AD CLSD' })).toBe(true)
    expect(isAerodromeClosureNotam({ qCode: 'QFACN', text: 'AD CLSD' })).toBe(false)
  })
})

describe('aerodromeClosure', () => {
  const now = at('2026-11-10T12:00:00Z')
  it('none', () => expect(aerodromeClosure([], AD, now)).toBeNull())
  it('plain closure now, until the end', () => {
    const c = aerodromeClosure([notam({})], AD, now)!
    expect(c.state).toBe('closed')
    expect(closureLabel(c, now)).toBe('Closed now until Mon 0000Z')
  })
  it('open-ended closure', () => {
    const c = aerodromeClosure([notam({ expires: null })], AD, now)!
    expect(closureLabel(c, now)).toBe('Closed now')
  })
  it('ended is ignored', () => {
    expect(aerodromeClosure([notam({ expires: '2026-11-09T00:00:00Z' })], AD, now)).toBeNull()
  })
  it('starts soon / later than the window', () => {
    const soon = aerodromeClosure([notam({ effective: '2026-11-10T20:00:00Z' })], AD, now)!
    expect(soon.state).toBe('soon')
    expect(closureLabel(soon, now)).toBe('Closed from 2000Z')
    expect(aerodromeClosure([notam({ effective: '2026-11-15T20:00:00Z' })], AD, now)).toBeNull()
  })
  it('scheduled closure: closed now only inside the schedule, with its end', () => {
    const n = notam({ schedule: 'MON-FRI 1000-1400' }) // Tue 10 Nov 2026
    const inside = aerodromeClosure([n], AD, at('2026-11-10T12:00:00Z'))!
    expect(inside.state).toBe('closed')
    expect(closureLabel(inside, at('2026-11-10T12:00:00Z'))).toBe('Closed now until 1400Z')
    const outside = aerodromeClosure([n], AD, at('2026-11-10T15:00:00Z'))!
    expect(outside.state).toBe('scheduled')
    expect(closureLabel(outside, at('2026-11-10T15:00:00Z'))).toBe('Closed at scheduled times, next from Wed 1000Z')
  })
  it('unreadable schedule is never "closed now"', () => {
    const c = aerodromeClosure([notam({ schedule: 'WHEN RAINING' })], AD, now)!
    expect(c.state).toBe('scheduled')
    expect(closureLabel(c, now)).toBe('Closed at scheduled times')
  })
  it('partial closure says Restricted', () => {
    const c = aerodromeClosure([notam({ text: 'AD CLSD EXC FOR AMBULANCE FLIGHTS' })], AD, now)!
    expect(c.partial).toBe(true)
    expect(closureLabel(c, now)).toMatch(/^Restricted now/)
    const t = aerodromeClosure([notam({ text: 'AD CLSD TO NON-BASED ACFT' })], AD, now)!
    expect(t.partial).toBe(true)
  })
  it('estimated end is marked', () => {
    const c = aerodromeClosure([notam({ estimated: true, expires: '2026-11-10T18:00:00Z' })], AD, now)!
    expect(closureLabel(c, now)).toBe('Closed now until 1800Z (est.)')
  })
  it('prefers closed-now over scheduled, full over partial', () => {
    const a = notam({ schedule: 'MON-FRI 0600-0800', nmsId: 'a' })
    const b = notam({ nmsId: 'b', text: 'AD CLSD EXC MIL' })
    const c = notam({ nmsId: 'c' })
    expect(aerodromeClosure([a, b, c], AD, now)!.notam.nmsId).toBe('c')
    expect(aerodromeClosure([a, b], AD, now)!.notam.nmsId).toBe('b')
  })
})
