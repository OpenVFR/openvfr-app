import { describe, it, expect } from 'vitest'
import { dropCoveredSubAreas } from './subAreas'

const sq = (x0: number, y0: number, x1: number, y1: number) =>
  ({ type: 'Polygon' as const, coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] })
const mk = (name: string, geometry: ReturnType<typeof sq>, upper_ft = 2000) =>
  ({ name, cls: 'R', type: 'R', lower_ft: 0, upper_ft, geometry })

describe('dropCoveredSubAreas', () => {
  const parent = mk('ESR121 REVINGE', sq(0, 0, 10, 10))
  it('drops children tiling the parent (shared edges)', () => {
    const out = dropCoveredSubAreas([parent, mk('ESR121A REVINGE', sq(0, 0, 5, 10)), mk('ESR121B REVINGE', sq(5, 0, 10, 10))])
    expect(out.map((f) => f.name)).toEqual(['ESR121 REVINGE'])
  })
  it('keeps a child outside the parent', () => {
    expect(dropCoveredSubAreas([parent, mk('ESR121C REVINGE', sq(20, 20, 30, 30))])).toHaveLength(2)
  })
  it('keeps a child with different limits', () => {
    expect(dropCoveredSubAreas([parent, mk('ESR121A REVINGE', sq(0, 0, 5, 10), 4500)])).toHaveLength(2)
  })
  it('keeps siblings with no parent', () => {
    expect(dropCoveredSubAreas([mk('ESR5A BODEN', sq(0, 0, 5, 5)), mk('ESR5B BODEN', sq(5, 0, 9, 5))])).toHaveLength(2)
  })
})
