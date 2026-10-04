import { describe, it, expect } from 'vitest'
import {
  cloudLayerPaths, cloudLayerLabel, cloudOpacityForOffset, cloudReportOffRouteNm,
  cloudReportIcao, placeCloudLabel, CLOUD_MAX_OFF_ROUTE_NM, CONVECTIVE_GLYPH_H, type LabelRect,
} from './cloudGlyph'
import { parseMetarClouds } from './fetchWx'

/** Y of every vertex in a path (M/L points and arc end points; arc radii,
 *  which follow `A`, are skipped). */
function ys(d: string): number[] {
  return [...d.matchAll(/(?:[ML]| 1 )(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[2]))
}

describe('parseMetarClouds', () => {
  it('keeps the CB/TCU suffix as a layer type', () => {
    expect(parseMetarClouds('FEW020 BKN035CB SCT050TCU')).toEqual([
      { cover: 'FEW', baseFt: 2000 },
      { cover: 'BKN', baseFt: 3500, type: 'CB' },
      { cover: 'SCT', baseFt: 5000, type: 'TCU' },
    ])
  })

  it('leaves type off plain layers', () => {
    expect(parseMetarClouds('OVC008')[0]).not.toHaveProperty('type')
  })
})

describe('cloudLayerPaths', () => {
  it('draws one body for FEW/OVC, two for SCT, three for BKN', () => {
    expect(cloudLayerPaths(0, 100, 50, { cover: 'FEW' }, 1)).toHaveLength(1)
    expect(cloudLayerPaths(0, 100, 50, { cover: 'SCT' }, 1)).toHaveLength(2)
    expect(cloudLayerPaths(0, 100, 50, { cover: 'BKN' }, 1)).toHaveLength(3)
    expect(cloudLayerPaths(0, 100, 50, { cover: 'OVC' }, 1)).toHaveLength(1)
  })

  it('never draws below the base', () => {
    for (const cover of ['FEW', 'SCT', 'BKN', 'OVC'] as const) {
      for (const d of cloudLayerPaths(0, 100, 50, { cover }, 3)) {
        expect(Math.max(...ys(d))).toBeLessThanOrEqual(50)
      }
    }
  })

  it('is deterministic for the same seed', () => {
    expect(cloudLayerPaths(0, 80, 40, { cover: 'SCT' }, 7)).toEqual(cloudLayerPaths(0, 80, 40, { cover: 'SCT' }, 7))
  })

  it('raises a tower for CB, squashed to fit maxH', () => {
    const [full] = cloudLayerPaths(0, 100, 100, { cover: 'FEW', type: 'CB' }, 1)
    expect(Math.min(...ys(full))).toBeCloseTo(100 - CONVECTIVE_GLYPH_H)
    const [squashed] = cloudLayerPaths(0, 100, 100, { cover: 'FEW', type: 'CB' }, 1, 14)
    expect(Math.min(...ys(squashed))).toBeGreaterThanOrEqual(100 - 14 - 0.01)
  })

  it('puts the convective tower on one cluster only', () => {
    const paths = cloudLayerPaths(0, 120, 100, { cover: 'BKN', type: 'TCU' }, 1)
    const towers = paths.filter((d) => Math.min(...ys(d)) < 100 - 20)
    expect(towers).toHaveLength(1)
  })
})

describe('cloudLayerLabel', () => {
  it('formats like the METAR group', () => {
    expect(cloudLayerLabel({ cover: 'BKN', baseFt: 1500 })).toBe('BKN015')
    expect(cloudLayerLabel({ cover: 'SCT', baseFt: 4000, type: 'CB' })).toBe('SCT040CB')
  })
})

describe('off-route reports', () => {
  it('fades with distance and drops past the limit', () => {
    expect(cloudOpacityForOffset(0)).toBe(1)
    expect(cloudOpacityForOffset(3)).toBe(1)
    const mid = cloudOpacityForOffset(7)
    expect(mid).toBeLessThan(1)
    expect(mid).toBeGreaterThan(0)
    expect(cloudOpacityForOffset(CLOUD_MAX_OFF_ROUTE_NM + 0.1)).toBe(0)
  })

  it('adds the borrow distance when the report came from another station', () => {
    expect(cloudReportOffRouteNm(2, { icao: 'ESMS' })).toBe(2)
    expect(cloudReportOffRouteNm(2, { icao: 'ESMS', sourceIcao: 'ESMS', sourceDistNm: null })).toBe(2)
    expect(cloudReportOffRouteNm(2, { icao: 'ESXX', sourceIcao: 'ESMS', sourceDistNm: 9 })).toBe(11)
    expect(cloudReportIcao({ icao: 'ESXX', sourceIcao: 'ESMS' })).toBe('ESMS')
  })
})

describe('placeCloudLabel', () => {
  it('goes under the base when free', () => {
    const taken: LabelRect[] = []
    expect(placeCloudLabel(50, 100, 14, 'FEW020 ESMS', taken, 0, 200)).toBe(110)
    expect(taken).toHaveLength(1)
  })

  it('moves above the glyph when an airspace chip sits under the base', () => {
    const taken: LabelRect[] = [{ x: 0, y: 100, w: 200, h: 13 }]
    expect(placeCloudLabel(50, 100, 14, 'FEW020 ESMS', taken, 0, 200)).toBe(100 - 14 - 3)
  })

  it('keeps labels inside the plot', () => {
    const y = placeCloudLabel(50, 195, 14, 'OVC005', [], 0, 200)
    expect(y).toBe(195 - 14 - 3)
  })
})
