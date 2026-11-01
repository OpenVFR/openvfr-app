import { describe, it, expect } from 'vitest'
import { rankTapCandidates } from './tapPick'

// Around ESMS: aerodrome at the tap's east, a reporting point drawn above it.
const tap = { lng: 13.37, lat: 55.536 }
const ad  = { item: 'ESMS', lng: 13.3762, lat: 55.536, isAerodrome: true }
const rp  = { item: 'RP',   lng: 13.366,  lat: 55.536, isAerodrome: false }

describe('rankTapCandidates', () => {
  it('nearest wins regardless of drawing order', () => {
    const near = { ...rp, lng: 13.3705 }
    expect(rankTapCandidates([near, ad], tap.lng, tap.lat)[0]).toBe('RP')
    expect(rankTapCandidates([ad, { ...rp, lng: 13.40 }], tap.lng, tap.lat)[0]).toBe('ESMS')
  })
  it('aerodrome wins unless the other point is more than twice as close', () => {
    // RP 0.004 deg away, aerodrome 0.0062: aerodrome scores 0.0031.
    expect(rankTapCandidates([rp, ad], tap.lng, tap.lat)[0]).toBe('ESMS')
    // RP 0.002 away beats the aerodrome's 0.0031.
    expect(rankTapCandidates([{ ...rp, lng: 13.368 }, ad], tap.lng, tap.lat)[0]).toBe('RP')
  })
  it('keeps the map order on a tie', () => {
    const a = { ...rp, item: 'A' }, b = { ...rp, item: 'B' }
    expect(rankTapCandidates([a, b], tap.lng, tap.lat)).toEqual(['A', 'B'])
  })
})
