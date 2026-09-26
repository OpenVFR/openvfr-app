import { describe, it, expect } from 'vitest'
import { parseMapLink, hasMapLink, stripMapLinkParams, buildAerodromeLink, buildPositionLink } from './deepLink'

describe('parseMapLink', () => {
  it('aerodrome', () => {
    expect(parseMapLink('?ad=essb')).toEqual({ ad: 'ESSB' })
  })
  it('coordinate in any supported format + zoom', () => {
    const l = parseMapLink('?c=5939N01756E&z=11')
    expect(l.center!.lat).toBeCloseTo(59.65, 5)
    expect(l.center!.lng).toBeCloseTo(17.93333, 4)
    expect(l.zoom).toBe(11)
    expect(parseMapLink('?c=59.1,18.2').center).toEqual({ lat: 59.1, lng: 18.2 })
  })
  it('ignores invalid values', () => {
    expect(parseMapLink('?ad=<script>&c=nope&z=99')).toEqual({})
    expect(parseMapLink('?ad=ES&z=abc')).toEqual({})
    expect(parseMapLink('?z=')).toEqual({})
  })
  it('hasMapLink', () => {
    expect(hasMapLink(parseMapLink('?z=10'))).toBe(false)
    expect(hasMapLink(parseMapLink('?ad=ESSB'))).toBe(true)
  })
})

describe('link building / stripping', () => {
  it('round-trips aerodrome', () => {
    const url = buildAerodromeLink('https://example.org/app/?foo=1', 'essb')
    expect(url).toBe('https://example.org/app/?ad=ESSB')
    expect(parseMapLink(new URL(url).search)).toEqual({ ad: 'ESSB' })
  })
  it('round-trips position', () => {
    const url = buildPositionLink('https://example.org/', 59.123456, 18.654321, 11.26)
    const l = parseMapLink(new URL(url).search)
    expect(l.center).toEqual({ lat: 59.12346, lng: 18.65432 })
    expect(l.zoom).toBe(11.3)
  })
  it('strips only owned params', () => {
    expect(stripMapLinkParams('https://example.org/?ad=ESSB&z=9&keep=1#h')).toBe('https://example.org/?keep=1#h')
  })
})
