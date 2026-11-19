import { describe, it, expect } from 'vitest'
import { formatCallsign } from './callsignFormat'

describe('formatCallsign', () => {
  it('writes all-capitals and all-lower-case callsigns in Title Case', () => {
    expect(formatCallsign('SÖDERSLÄTT')).toBe('Söderslätt')
    expect(formatCallsign('sövde radio')).toBe('Sövde Radio')
    expect(formatCallsign('STOCKHOLM CONTROL')).toBe('Stockholm Control')
    expect(formatCallsign('ÖSTRA-KARUP RADIO')).toBe('Östra-Karup Radio')
  })
  it('leaves a callsign in mixed case as it is', () => {
    expect(formatCallsign('Sweden Information')).toBe('Sweden Information')
    expect(formatCallsign('Söderslätts Radio')).toBe('Söderslätts Radio')
  })
  it('keeps abbreviations without a spoken form in capitals', () => {
    expect(formatCallsign('SÖVDE ATIS')).toBe('Sövde ATIS')
    expect(formatCallsign('MALMÖ AFIS')).toBe('Malmö AFIS')
  })
  it('handles empty values', () => {
    expect(formatCallsign(null)).toBe('')
    expect(formatCallsign('  ')).toBe('')
  })
})
