import { describe, it, expect } from 'vitest'
import { bandTag } from './virtualRadarCalc'

describe('bandTag', () => {
  it('uses only the designator for restricted areas and TRAs', () => {
    expect(bandTag('R', 'R', 'ESR121A REVINGE')).toBe('ESR121A')
    expect(bandTag('TRA', 'TRA', '  ESTRA12 Foo Bar')).toBe('ESTRA12')
  })
  it('falls back to class when name is empty', () => {
    expect(bandTag('R', 'R', '')).toBe('R')
  })
  it('uses class letter for controlled airspace', () => {
    expect(bandTag('C', 'CTA', 'Stockholm CTA')).toBe('C')
  })
})
