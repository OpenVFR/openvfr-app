import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchWxNearest, decodeMetar } from './fetchWx'

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response
}

describe('fetchWxNearest', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('falls through to the nearest candidate when the requested ICAO 400s (malformed pseudo-ICAO)', async () => {
    // Regression: some aerodromes carry a non-standard, longer-than-4-letter
    // pseudo-ICAO for small private strips without a real one (e.g.
    // "ESTAGA" for Trelleborg/T\u00e5garp) -- the backend 400s those. That
    // used to throw straight out of fetchWxNearest entirely (own-icao fetch
    // wasn't wrapped in try/catch, unlike every candidate fetch), skipping
    // the fallback search and surfacing a bare "Weather unavailable"
    // instead of the nearest real station's actual report.
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      if (url.includes('ESTAGA')) return mockResponse(400, { error: 'Invalid ICAO identifier' })
      if (url.includes('ESMS'))    return mockResponse(200, { metar: 'ESMS 140820Z 26008KT 9999 SCT012 14/13 Q1021', taf: null })
      return mockResponse(200, { metar: null, taf: null })
    }))

    const result = await fetchWxNearest('ESTAGA', [{ icao: 'ESMS', distNm: 12.3 }])
    expect(result.sourceIcao).toBe('ESMS')
    expect(result.distNm).toBe(12.3)
    expect(result.metar).toContain('ESMS')
    expect(calls.length).toBe(2) // tried ESTAGA (400), then fell through to ESMS
  })

  it('returns the requested ICAO\'s own data when it succeeds, without touching candidates', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      mockResponse(200, { metar: url.includes('ESSA') ? 'ESSA 140820Z 27010KT 9999 FEW030 15/10 Q1015' : null, taf: null }),
    ))
    const result = await fetchWxNearest('ESSA', [{ icao: 'ESSB', distNm: 5 }])
    expect(result.sourceIcao).toBe('ESSA')
    expect(result.distNm).toBeNull()
  })

  it('reports the originally-requested ICAO with null data when nothing is found anywhere nearby', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse(200, { metar: null, taf: null })))
    const result = await fetchWxNearest('ESTAGA', [{ icao: 'ESMS', distNm: 12 }])
    expect(result.sourceIcao).toBe('ESTAGA')
    expect(result.metar).toBeNull()
    expect(result.distNm).toBeNull()
  })
})

describe('decodeMetar obsMs', () => {
  it('resolves the DDHHMMZ group to an epoch close to the reference time', () => {
    const ref = Date.UTC(2026, 8, 14, 8, 25) // 14 Sep 2026 08:25Z
    const decoded = decodeMetar('ESMS 140820Z 26008KT 9999 SCT012 14/13 Q1021', ref)
    expect(decoded.obsMs).toBe(Date.UTC(2026, 8, 14, 8, 20))
  })
})
