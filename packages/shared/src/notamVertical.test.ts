import { describe, it, expect } from 'vitest'
import {
  parseVerticalLimit, parseVerticalSection, verticalSectionsFromText, notamVertical,
  formatNotamVertical,
} from './notamVertical'

const AGL0 = { ref: 'AGL', ft: 0 }

describe('parseVerticalLimit', () => {
  it('surface words, flight levels, feet, metres, unlimited', () => {
    expect(parseVerticalLimit('SFC')).toEqual(AGL0)
    expect(parseVerticalLimit('GND')).toEqual(AGL0)
    expect(parseVerticalLimit('FL095')).toEqual({ ref: 'FL', ft: 9500 })
    expect(parseVerticalLimit('FL 65')).toEqual({ ref: 'FL', ft: 6500 })
    expect(parseVerticalLimit('1800FT AMSL')).toEqual({ ref: 'AMSL', ft: 1800 })
    expect(parseVerticalLimit('1.500FT ASFC')).toEqual({ ref: 'AGL', ft: 1500 })
    expect(parseVerticalLimit('1,500 FT AGL')).toEqual({ ref: 'AGL', ft: 1500 })
    expect(parseVerticalLimit('600 M AMSL')).toEqual({ ref: 'AMSL', ft: 1969 })
    expect(parseVerticalLimit('UNL')).toMatchObject({ ref: 'FL', unlimited: true })
  })
  it('a bare number has no reference: refused', () => {
    expect(parseVerticalLimit('1800')).toBeNull()
    expect(parseVerticalLimit('')).toBeNull()
    expect(parseVerticalLimit(null)).toBeNull()
  })
})

describe('fixture 16: vertical pairs', () => {
  it('SFC - FL 095', () => {
    expect(parseVerticalSection('SFC - FL 095')).toEqual({ floor: AGL0, ceiling: { ref: 'FL', ft: 9500 } })
    expect(parseVerticalSection('SFC-FL095')).toEqual({ floor: AGL0, ceiling: { ref: 'FL', ft: 9500 } })
  })
  it('1.500FT ASFC - 3.500 FT AMSL', () => {
    expect(parseVerticalSection('1.500FT ASFC - 3.500 FT AMSL')).toEqual({
      floor: { ref: 'AGL', ft: 1500 }, ceiling: { ref: 'AMSL', ft: 3500 },
    })
  })
  it('600 M AMSL alone is a ceiling', () => {
    expect(parseVerticalSection('600 M AMSL')).toEqual({ floor: null, ceiling: { ref: 'AMSL', ft: 1969 } })
  })
  it('FL 65 - UNL', () => {
    const p = parseVerticalSection('FL 65 - UNL')!
    expect(p.floor).toEqual({ ref: 'FL', ft: 6500 })
    expect(p.ceiling?.unlimited).toBe(true)
  })
  it('upper written first is swapped', () => {
    expect(parseVerticalSection('3000FT AMSL / 1000FT AMSL')).toEqual({
      floor: { ref: 'AMSL', ft: 1000 }, ceiling: { ref: 'AMSL', ft: 3000 },
    })
  })
  it('shared unit and reference: 400-700FT AMSL', () => {
    expect(parseVerticalSection('400-700FT AMSL')).toEqual({ floor: { ref: 'AMSL', ft: 400 }, ceiling: { ref: 'AMSL', ft: 700 } })
  })
  it('unreadable or three values: refused', () => {
    expect(parseVerticalSection('SEE AIP')).toBeNull()
    expect(parseVerticalSection('1000FT AMSL 2000FT AMSL 3000FT AMSL')).toBeNull()
  })
  it('two polygons with one pair: refused, Q-line used', () => {
    const text = 'AREA 1: 5712N 01200E - 5718N 01215E - 5705N 01220E - 5712N 01200E. VERTICAL LIMITS: SFC - FL095. AREA 2: more'
    expect(notamVertical({ text, icao: { lowerFl: '000', upperFl: '100' } }, 2)?.source).toBe('qline')
    expect(notamVertical({ text }, 2)).toBeNull()
    expect(notamVertical({ text }, 1)?.source).toBe('text')
  })
})

describe('notamVertical', () => {
  it('fixture 13: item E section', () => {
    const text = '571200N 0120030E - 571800N 0121500E. VERTICAL LIMITS: GND - 2000 FT AMSL'
    const v = notamVertical({ text }, 1)!
    expect(v.pairs).toEqual([{ floor: AGL0, ceiling: { ref: 'AMSL', ft: 2000 } }])
    expect(formatNotamVertical(v)).toBe('GND – 2000 FT AMSL')
  })
  it('section stops at the next label (live: 400-700FT AMSL CONTACT: ...)', () => {
    const text = 'BANNER TOWING\nVERTICAL LIMITS:\n400-700FT AMSL\nCONTACT: EXPERT FLIGHT +00 000 0000\nACFT: SP-SEFT'
    expect(verticalSectionsFromText(text)).toEqual([{ floor: { ref: 'AMSL', ft: 400 }, ceiling: { ref: 'AMSL', ft: 700 } }])
  })
  it('one section per area', () => {
    const text = 'AREA 1 ... VERTICAL LIMITS: GND - 1000FT AMSL. AREA 2 ... VERTICAL LIMITS: GND - FL050.'
    const v = notamVertical({ text }, 2)!
    expect(v.pairs.map(p => p.ceiling?.ft)).toEqual([1000, 5000])
  })
  it('items F) and G) win and apply to every area', () => {
    const v = notamVertical({ text: 'X', icao: { lowerLimit: 'GND', upperLimit: '2000FT AMSL' } }, 3)!
    expect(v.source).toBe('fg')
    expect(v.pairs).toHaveLength(3)
  })
  it('Q-line fallback: 000/999 = surface to unlimited', () => {
    const v = notamVertical({ text: 'X', icao: { lowerFl: '000', upperFl: '999' } }, 1)!
    expect(formatNotamVertical(v)).toBe('GND – UNL')
    expect(formatNotamVertical(notamVertical({ text: 'X', icao: { lowerFl: '010', upperFl: '095' } }, 1))).toBe('FL010 – FL095')
  })
})

describe('stricter pairing', () => {
  it('limits far apart in the text are not one pair', () => {
    expect(parseVerticalSection('GND AND SOME TEXT WELL IN BETWEEN AND THEN 2000FT AMSL')).toBeNull()
    expect(parseVerticalSection('GND TO 2000FT AMSL')).not.toBeNull()
  })
  it('bare MSL is 0 ft AMSL', () => {
    expect(parseVerticalSection('MSL - 500FT AGL')).toEqual({ floor: { ref: 'AMSL', ft: 0 }, ceiling: { ref: 'AGL', ft: 500 } })
    expect(parseVerticalLimit('2000FT MSL')).toEqual({ ref: 'AMSL', ft: 2000 })
  })
  it('shared unit with a slash: 800/1500FT AMSL', () => {
    expect(parseVerticalSection('800/1500FT AMSL')).toEqual({ floor: { ref: 'AMSL', ft: 800 }, ceiling: { ref: 'AMSL', ft: 1500 } })
  })
})
