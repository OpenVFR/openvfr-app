import { describe, it, expect } from 'vitest'
import { parseMapLink, hasMapLink, stripMapLinkParams } from './deepLink'

describe('parseMapLink', () => {
  it('saved route by id, only a UUID', () => {
    expect(parseMapLink('?route=0F8FAD5B-D9CB-469F-A165-70867728950E').route).toBe('0f8fad5b-d9cb-469f-a165-70867728950e')
    expect(parseMapLink('?route=current').route).toBeUndefined()
    expect(hasMapLink(parseMapLink('?route=0f8fad5b-d9cb-469f-a165-70867728950e'))).toBe(true)
  })
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

describe('link stripping', () => {
  it('strips only owned params', () => {
    expect(stripMapLinkParams('https://example.org/?ad=ESSB&z=9&keep=1#h')).toBe('https://example.org/?keep=1#h')
  })
})
