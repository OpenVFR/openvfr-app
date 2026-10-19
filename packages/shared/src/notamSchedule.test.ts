import { describe, it, expect } from 'vitest'
import { parseNotamSchedule, scheduleOverlaps } from './notamSchedule'

const POS = { lat: 54.3, lon: 12.2 }
const at = (iso: string) => Date.parse(iso)
const on = (d: string | null, iso: string, mins = 1, text?: string, eff = '2026-10-01T00:00:00Z') => {
  const s = parseNotamSchedule({ itemD: d, text, effective: eff })
  expect(s, d ?? text ?? '').not.toBeNull()
  return scheduleOverlaps(s!, at(iso), at(iso) + mins * 60_000, POS)
}
// Mon 19 Oct 2026, Sat 24 Oct 2026

describe('item D schedules (live samples)', () => {
  it('weekday groups', () => {
    const d = 'MON-THU 0700-1630, FRI 0700-1200'
    expect(on(d, '2026-10-19T08:00:00Z')).toBe(true)
    expect(on(d, '2026-10-19T17:00:00Z')).toBe(false)
    expect(on(d, '2026-10-23T13:00:00Z')).toBe(false) // Fri afternoon
    expect(on(d, '2026-10-23T11:00:00Z')).toBe(true)
    expect(on(d, '2026-10-24T08:00:00Z')).toBe(false)
  })
  it('DAILY / bare time / H24', () => {
    expect(on('DAILY 0600-2200', '2026-10-19T05:00:00Z')).toBe(false)
    expect(on('0600-2200', '2026-10-19T07:00:00Z')).toBe(true)
    expect(on('MON-FRI H24', '2026-10-24T07:00:00Z')).toBe(false)
    expect(on('MON-FRI H24', '2026-10-21T03:00:00Z')).toBe(true)
  })
  it('past midnight and sun-relative', () => {
    expect(on('0900-0100', '2026-10-19T00:30:00Z')).toBe(true)
    expect(on('0900-0100', '2026-10-19T05:00:00Z')).toBe(false)
    const d = 'DAILY SS PLUS30 - 0300'
    expect(on(d, '2026-10-19T12:00:00Z')).toBe(false)
    expect(on(d, '2026-10-19T20:00:00Z')).toBe(true)
    expect(on(d, '2026-10-20T02:00:00Z')).toBe(true)
    expect(on('DAILY SR-SS', '2026-10-19T12:00:00Z')).toBe(true)
    expect(on('DAILY SR-SS', '2026-10-19T22:00:00Z')).toBe(false)
  })
  it('several time groups', () => {
    expect(on('0600-0915 1120-1300', '2026-10-19T10:00:00Z')).toBe(false)
    expect(on('0600-0915 1120-1300', '2026-10-19T12:00:00Z')).toBe(true)
    expect(on('DAILY 0600-1000, 1115-1600', '2026-10-19T14:00:00Z')).toBe(true)
    expect(on('DAILY 0600-1000, 1115-1600', '2026-10-19T11:00:00Z')).toBe(false)
  })
  it('weekday span across days', () => {
    const d = 'MON-THU 2000-0600, FRI 1500-MON 0600'
    expect(on(d, '2026-10-24T12:00:00Z')).toBe(true)  // Sat
    expect(on(d, '2026-10-19T05:00:00Z')).toBe(true)  // Mon early (Fri->Mon)
    expect(on(d, '2026-10-19T12:00:00Z')).toBe(false)
  })
  it('day-of-month lists in the effective month', () => {
    const d = '05-08 0500-1600, 09 0500-1000, 12-15 0500-1600, 19 0500-1600, 20 21 0500-2200'
    expect(on(d, '2026-10-19T10:00:00Z', 1, undefined, '2026-10-05T00:00:00Z')).toBe(true)
    expect(on(d, '2026-10-18T10:00:00Z', 1, undefined, '2026-10-05T00:00:00Z')).toBe(false)
    expect(on(d, '2026-10-19T17:00:00Z', 1, undefined, '2026-10-05T00:00:00Z')).toBe(false)
  })
  it('month names and rolling into the next month', () => {
    const d = 'OCT 14 0000-0400, 17 24 31 1300-1400, NOV 01 0000-0400'
    expect(on(d, '2026-10-24T13:30:00Z')).toBe(true)
    expect(on(d, '2026-10-25T13:30:00Z')).toBe(false)
    expect(on(d, '2026-11-01T01:00:00Z')).toBe(true)
  })
  it('month ranges with weekdays', () => {
    const d = 'OCT 01-25 MON-THU 0500-1430 FRI 0500-0900, OCT 07 1430-2200, OCT 26-DEC 11 MON-THU 0600-1530 FRI 0600-1000'
    expect(on(d, '2026-10-19T10:00:00Z')).toBe(true)
    expect(on(d, '2026-10-19T16:00:00Z')).toBe(false)
    expect(on(d, '2026-10-30T08:00:00Z')).toBe(true)  // Fri in second range
    expect(on(d, '2026-10-30T11:00:00Z')).toBe(false)
  })
  it('EXC dates and weekdays', () => {
    const d = 'MON-FRI 0500-1400 EXC MAY 14 JUN 19'
    expect(on(d, '2026-10-19T10:00:00Z', 1, undefined, '2026-05-01T00:00:00Z')).toBe(true)
    const p = parseNotamSchedule({ itemD: d, effective: '2026-05-01T00:00:00Z' })!
    expect(scheduleOverlaps(p, at('2026-05-14T10:00:00Z'), at('2026-05-14T10:01:00Z'), POS)).toBe(false)
    expect(scheduleOverlaps(p, at('2026-06-19T10:00:00Z'), at('2026-06-19T10:01:00Z'), POS)).toBe(false)
  })
  it('periods from one day/time to another', () => {
    const d = '13-15 0500-1400, 16 0500-1000, 19 0500-1400, 20 0500 - 21 1400'
    const eff = '2026-10-13T00:00:00Z'
    expect(on(d, '2026-10-20T23:00:00Z', 1, undefined, eff)).toBe(true)  // inside 20 0500 -> 21 1400
    expect(on(d, '2026-10-21T15:00:00Z', 1, undefined, eff)).toBe(false)
    expect(on(d, '2026-10-19T10:00:00Z', 1, undefined, eff)).toBe(true)
    expect(on('12 0600-16 1600, 19-23 0600-1600', '2026-10-14T02:00:00Z', 1, undefined, eff)).toBe(true)
  })
  it('window overlap, not just a point', () => {
    expect(on('DAILY 0600-1000', '2026-10-19T09:30:00Z', 120)).toBe(true)
    expect(on('DAILY 0600-1000', '2026-10-19T10:30:00Z', 60)).toBe(false)
  })
  it('unparseable -> null (treated as always in force)', () => {
    expect(parseNotamSchedule({ itemD: 'SEE AIP SUP 12/26' })).toBeNull()
    expect(parseNotamSchedule({ itemD: null, text: 'RWY 12 CLSD' })).toBeNull()
  })
})

describe('schedule at the start of E)', () => {
  const DE = 'MON-THU, DAILY SS+30 - 23:00, EXCEPT GERMAN HOLIDAYS NVG\nTRAINING OF MIL HELICOPTERS WITH LIGHT AMPLIFYING DEVICES'
  const DE2 = 'MON-THU daily 30 minutes after sunset - 23:00, except german holidays nvg training'
  for (const text of [DE, DE2]) {
    it(text.slice(0, 30), () => {
      // Mon 19 Oct 06:24z (the screenshot): not active
      expect(on(null, '2026-10-19T06:24:00Z', 1, text)).toBe(false)
      expect(on(null, '2026-10-19T20:00:00Z', 1, text)).toBe(true)
      expect(on(null, '2026-10-24T20:00:00Z', 1, text)).toBe(false) // Sat
      expect(parseNotamSchedule({ text })!.holidays).toBe(true)
    })
  }
  it('does not read a range of numbers in prose as a schedule', () => {
    expect(parseNotamSchedule({ text: 'BTN 1200-1500FT AMSL OBST ERECTED' })).toBeNull()
    expect(parseNotamSchedule({ text: 'UAS OPERATION 1NM RADIUS' })).toBeNull()
  })
})
