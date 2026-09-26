import { describe, it, expect } from 'vitest'
import { decodeQCode, extractQCodeFromText, normalizeQCode, notamTitle } from './notamQCode'

describe('decodeQCode', () => {
  it('decodes subject + condition', () => {
    expect(decodeQCode('QMRLC')).toEqual({ code: 'QMRLC', subject: 'Runway', condition: 'closed' })
    expect(decodeQCode('QRTCA')).toEqual({ code: 'QRTCA', subject: 'Temporary restricted area', condition: 'activated' })
    expect(decodeQCode('QOBCE')?.subject).toBe('Obstacle')
  })
  it('XX/TT condition = subject only', () => {
    expect(decodeQCode('QWPXX')?.condition).toBeNull()
    expect(decodeQCode('QFATT')?.condition).toBeNull()
  })
  it('checklist', () => expect(decodeQCode('QKKKK')?.subject).toBe('Checklist'))
  it('unknown subject is null, not a guess', () => expect(decodeQCode('QQQLC')?.subject).toBeNull())
  it('malformed is null', () => {
    expect(decodeQCode('QMRL')).toBeNull()
    expect(decodeQCode('')).toBeNull()
    expect(decodeQCode(null)).toBeNull()
  })
})

describe('normalizeQCode / extractQCodeFromText', () => {
  it('normalizes', () => {
    expect(normalizeQCode(' qmrlc ')).toBe('QMRLC')
    expect(normalizeQCode('MRLC')).toBe('QMRLC')
  })
  it('extracts from ICAO Q) line', () => {
    expect(extractQCodeFromText('A1234/26 NOTAMN\nQ) ESAA/QMRLC/IV/NBO/A/000/999/5939N01756E005\nA) ESSA')).toBe('QMRLC')
    expect(extractQCodeFromText('RWY 01L CLSD')).toBeNull()
  })
})

describe('notamTitle', () => {
  it('subject + condition + id', () => {
    expect(notamTitle({ id: 'A1234/26', qCode: 'QMRLC' })).toBe('Runway closed · A1234/26')
  })
  it('falls back to Q) line in text', () => {
    expect(notamTitle({ id: 'B1/26', text: 'Q) ESAA/QWULW/IV/BO/W/000/020/' })).toBe('Unmanned aircraft will take place · B1/26')
  })
  it('bare id when unknown', () => {
    expect(notamTitle({ id: 'C9/26' })).toBe('C9/26')
    expect(notamTitle({ id: 'C9/26', qCode: 'QQQXX' })).toBe('C9/26')
  })
  it('keeps abbreviations', () => {
    expect(notamTitle({ id: 'D1/26', qCode: 'QLPAS' })).toBe('PAPI unserviceable · D1/26')
  })
})
