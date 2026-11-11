import { describe, it, expect } from 'vitest'
import { supScheduleItemD, supScheduleLine } from './supSchedule'

const at = (iso: string) => Date.parse(iso)
const sup = (schedule: string, from = '2026-01-01T00:00Z', until = '2027-12-31T23:59Z') =>
  ({ source: 'sup', schedule, active_from: from, active_until: until })

describe('supScheduleItemD (real samples)', () => {
  it('weekday range with local time in brackets', () => {
    expect(supScheduleItemD('01 SEP 2026 \u2013 31 JAN 2027, MON \u2013 FRI 0700 \u2013 1700 (0600 \u2013 1600)')).toBe('MON - FRI 0700 - 1700')
  })
  it('daily, lower case and bilingual', () => {
    expect(supScheduleItemD('09 FEB  - 31 DEC,  daily 0700-2130 (0600-2030)')).toBe('DAILY 0700-2130')
    expect(supScheduleItemD('01 SEP 2026 \u2013 31 DEC 2027, Dagligen / Daily 0700 \u2013 1600 (0600 \u2013 1500)')).toBe('DAILY 0700 - 1600')
  })
  it('day range before the month', () => {
    expect(supScheduleItemD('10 \u2013 13 NOV, DAILY 0700 \u2013 1700')).toBe('DAILY 0700 - 1700')
    expect(supScheduleItemD('10 \u2013 11 NOV 0800 \u2013 1600')).toBeNull()
  })
  it('a later date range does not limit an earlier undated line', () => {
    expect(supScheduleItemD('MON 0700-1700\n01 OCT - 31 OCT, TUE 0800-1000')).toBeNull()
  })
  it('several weekday lines under one date range', () => {
    expect(supScheduleItemD('01 JAN 2026 \u2013 31 DEC 2026\nMON-THU 0600 - 1900 (0500 - 1800)\nFRI 0600 - 1300 (0500 - 1200)'))
      .toBe('MON-THU 0600 - 1900, FRI 0600 - 1300')
  })
  it('not regular: date only, H24, absolute spans, mixed date ranges', () => {
    expect(supScheduleItemD('07 OCT 2026 \u2013 31 AUG 2027')).toBeNull()
    expect(supScheduleItemD('23 MAR \u2013 31 DEC H24')).toBeNull()
    expect(supScheduleItemD('26 OCT 0700 \u2013 30 OCT 1400\n02 NOV 0700 \u2013 06 NOV 1400')).toBeNull()
    expect(supScheduleItemD('30 MAR \u2013 27 APR, MON \u2013 FRI 0600 \u2013 1730\n28 APR 0600 \u2013 01 MAY 2200')).toBeNull()
    expect(supScheduleItemD('10 AUG \u2013 24 OCT 0500 \u2013 1800\n25 OCT \u2013 10 NOV 0600 \u2013 1900')).toBeNull()
  })
})

describe('supScheduleLine', () => {
  const p = sup('01 SEP 2026 \u2013 31 JAN 2027, MON \u2013 FRI 0700 \u2013 1700 (0600 \u2013 1600)', '2026-09-01T07:00Z', '2027-01-31T17:00Z')
  it('inside, with its end', () => {
    expect(supScheduleLine(p, at('2026-11-11T10:00:00Z'))).toBe('Now: in its scheduled hours (until 17:00Z)') // Wed
  })
  it('outside, with the next start', () => {
    expect(supScheduleLine(p, at('2026-11-13T18:00:00Z'))).toBe('Now: outside its scheduled hours (next from Mon 07:00Z)') // Fri evening
  })
  it('says nothing for other sources, unreadable text, or outside the validity', () => {
    expect(supScheduleLine({ source: 'ofmx', schedule: 'DAILY 0700-1700' })).toBeNull()
    expect(supScheduleLine(sup('23 MAR \u2013 31 DEC H24'), at('2026-11-11T10:00:00Z'))).toBeNull()
    expect(supScheduleLine(p, at('2026-08-01T10:00:00Z'))).toBeNull()
    expect(supScheduleLine(p, at('2027-03-01T10:00:00Z'))).toBeNull()
  })
})
