import { describe, it, expect } from 'vitest'
import { bandTag, mergeCoveredParents } from './virtualRadarCalc'

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

describe('mergeCoveredParents', () => {
  const b = (tag: string, entryNm: number, exitNm: number, extra = {}) =>
    ({ class: 'R', tag, lower_ft: 0, upper_ft: 2000, entryNm, exitNm, ...extra }) as
      { class: string; tag: string; freq?: string; lower_ft: number; upper_ft: number; entryNm: number; exitNm: number }

  it('drops a parent covered by its sectors and hands its frequency to the first one', () => {
    const out = mergeCoveredParents([b('ESR121', 2.5, 10.5, { freq: '126.155' }), b('ESR121A', 2.5, 6.5), b('ESR121B', 6.5, 10.5)])
    expect(out.map((x) => x.tag)).toEqual(['ESR121A', 'ESR121B'])
    expect(out[0].freq).toBe('126.155')
    expect(out[1].freq).toBeUndefined()
  })
  it('keeps a parent with an uncovered stretch', () => {
    expect(mergeCoveredParents([b('ESR121', 2, 10), b('ESR121A', 2, 6)]).map((x) => x.tag)).toEqual(['ESR121', 'ESR121A'])
  })
  it('keeps a parent whose limits differ', () => {
    const out = mergeCoveredParents([b('ESR121', 2, 10), b('ESR121A', 2, 10, { upper_ft: 1500 })])
    expect(out).toHaveLength(2)
  })
})
