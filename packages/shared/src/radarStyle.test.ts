import { describe, it, expect } from 'vitest'
import { symbolGroundY, poiCenterY, terrainGradientStops, phaseLabelText } from './radarStyle'

describe('symbolGroundY', () => {
  it('ends the symbol on the real ground, never below the plot', () => {
    expect(symbolGroundY(100, 110, 300)).toBe(110)
    expect(symbolGroundY(100, 250, 300)).toBe(250)
    expect(symbolGroundY(290, 320, 300)).toBe(300)
  })
})
describe('poiCenterY', () => {
  it('stands on the ground line and stays inside the plot', () => {
    expect(poiCenterY(200, 300)).toBe(193)
    expect(poiCenterY(299, 300)).toBe(292)
  })
})
describe('terrainGradientStops', () => {
  it('maps elevations onto the scale, top first', () => {
    const s = terrainGradientStops(0, 5000)
    expect(s[0].offset).toBe(0)
    expect(s[s.length - 1].offset).toBe(100)
    expect(s.find((x) => x.color === '#8fa850')!.offset).toBeCloseTo(80)
  })
  it('follows a raised floor', () => {
    expect(terrainGradientStops(1000, 5000).find((x) => x.color === '#8fa850')!.offset).toBe(100)
  })
})
describe('phaseLabelText', () => {
  it('words TOC, TOD and a climb that falls short', () => {
    expect(phaseLabelText('TOC', 3416)).toBe('TOC 3416 ft')
    expect(phaseLabelText('TOD', 3500)).toBe('TOD')
    expect(phaseLabelText('TOC', 2200, 4500)).toBe('TOC 2200 ft (4500 ft set)')
  })
})

import { windAloftFit } from './radarStyle'
describe('windAloftFit', () => {
  const bounds = { left: 0, right: 400 }
  const chip = { left: 110, right: 160, top: 90, bottom: 104 }
  it('keeps the label on the right when clear', () => {
    expect(windAloftFit(50, 100, 40, [chip], bounds)).toEqual({ barb: true, label: 'right' })
  })
  it('moves the label left when the right side hits a chip', () => {
    expect(windAloftFit(110 - 12 - 4, 97, 40, [chip], bounds).label).toBe('left')
  })
  it('drops the label when neither side is free, and the barb when it is under a chip', () => {
    expect(windAloftFit(135, 200, 40, [{ left: 150, right: 200, top: 190, bottom: 210 }, { left: 60, right: 120, top: 190, bottom: 210 }], bounds)).toEqual({ barb: true, label: null })
    expect(windAloftFit(135, 97, 40, [chip], bounds)).toEqual({ barb: false, label: null })
  })
})
