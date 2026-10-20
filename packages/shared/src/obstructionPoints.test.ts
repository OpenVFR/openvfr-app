import { describe, it, expect } from 'vitest'
import type { FeatureCollection } from 'geojson'
import { buildObstructionPoints } from './obstructionPoints'

const fc = (props: Record<string, unknown>[]): FeatureCollection => ({
  type: 'FeatureCollection',
  features: props.map((p, i) => ({ type: 'Feature', properties: p, geometry: { type: 'Point', coordinates: [17 + i * 0.1, 60] } })),
})

describe('buildObstructionPoints', () => {
  it('uses a recorded height as is', () => {
    const [p] = buildObstructionPoints(fc([{ kind: 'tower', elevation_ft: 100, height_m: 100 }]), null, [])
    expect(p.tipFt).toBe(100 + 328)
    expect(p.estimated).toBe(false)
  })
  it('estimates a missing height instead of treating the tip as ground', () => {
    const [p] = buildObstructionPoints(fc([{ kind: 'wind_turbine', elevation_ft: 100 }]), null, [])
    expect(p.tipFt).toBe(100 + Math.round(135 * 3.28084))
    expect(p.estimated).toBe(true)
  })
  it('skips landmarks without a ground grid', () => {
    expect(buildObstructionPoints(null, fc([{ kind: 'mast', height_m: 50 }]), [])).toEqual([])
  })
  it('gives unique keys even for equal names', () => {
    const pts = buildObstructionPoints(fc([{ kind: 'tower', name: 'A', elevation_ft: 1, height_m: 5 }, { kind: 'tower', name: 'A', elevation_ft: 1, height_m: 5 }]), null, [])
    expect(new Set(pts.map((x) => x.key)).size).toBe(2)
  })
})
