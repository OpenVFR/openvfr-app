import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchWxNearest, fetchWxResolved, decodeMetar } from './fetchWx'

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

describe('fetchWxResolved', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('falls back to Open-Meteo model wind when no METAR/TAF exists anywhere nearby', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/weather'))    return mockResponse(200, { metar: null, taf: null })
      if (url.includes('/api/open-meteo')) return mockResponse(200, { current: { wind_speed_10m: 12, wind_direction_10m: 250 } })
      throw new Error(`unexpected fetch: ${url}`)
    }))
    const result = await fetchWxResolved('ESTAGA', 55.4, 13.2, [{ icao: 'ESMS', distNm: 12 }])
    expect(result.metar).toBeNull()
    expect(result.taf).toBeNull()
    expect(result.modelWind).toEqual({ dirDeg: 250, speedKts: 12 })
  })

  it('never touches Open-Meteo when a real METAR/TAF was found', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return mockResponse(200, { metar: 'ESSA 140820Z 27010KT 9999 FEW030 15/10 Q1015', taf: null })
    }))
    const result = await fetchWxResolved('ESSA', 59.6, 17.9, [])
    expect(result.modelWind).toBeNull()
    expect(calls.some((u) => u.includes('open-meteo'))).toBe(false)
  })

  it('keeps the station\'s own wind (no model fallback) when the fallback candidate is within WIND_LOCAL_MAX_NM', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('ESTAGA')) return mockResponse(400, { error: 'Invalid ICAO identifier' })
      return mockResponse(200, { metar: 'ESMS 140820Z 26008KT 9999 SCT012 14/13 Q1021', taf: null })
    }))
    const result = await fetchWxResolved('ESTAGA', 55.52, 13.36, [{ icao: 'ESMS', distNm: 12 }])
    expect(result.sourceIcao).toBe('ESMS')
    expect(result.modelWind).toBeNull() // 12 NM is well within WIND_LOCAL_MAX_NM -- station's own wind is trusted
  })

  it('swaps to model wind even though a real METAR WAS found, when that station is farther than WIND_LOCAL_MAX_NM', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('ESTAGA'))          return mockResponse(400, { error: 'Invalid ICAO identifier' })
      if (url.includes('/api/open-meteo')) return mockResponse(200, { current: { wind_speed_10m: 8, wind_direction_10m: 190 } })
      return mockResponse(200, { metar: 'ESGG 140820Z 27015KT 9999 BKN020 12/09 Q1010', taf: null })
    }))
    const result = await fetchWxResolved('ESTAGA', 56.9, 12.1, [{ icao: 'ESGG', distNm: 62 }])
    expect(result.sourceIcao).toBe('ESGG')       // vis/ceiling/QNH/temp/cloud still come from the real station
    expect(result.metar).toContain('ESGG')
    expect(result.modelWind).toEqual({ dirDeg: 190, speedKts: 8 }) // but wind is modelled -- 62 NM > WIND_LOCAL_MAX_NM
  })

  it('degrades to modelWind: null (not a thrown error) when the model fetch itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/weather')) return mockResponse(200, { metar: null, taf: null })
      return mockResponse(500, {})
    }))
    // Distinct coordinates from the other fetchWxResolved tests --
    // fetchWind has its own 30-min in-memory cache keyed by rounded
    // lat/lng, and reusing the same point as the success-case test above
    // would silently serve its cached result instead of exercising this
    // failure path.
    const result = await fetchWxResolved('ESTAGA', 61.1, 21.7, [])
    expect(result.metar).toBeNull()
    expect(result.modelWind).toBeNull()
  })
})

describe('decodeMetar obsMs', () => {
  it('resolves the DDHHMMZ group to an epoch close to the reference time', () => {
    const ref = Date.UTC(2026, 8, 14, 8, 25) // 14 Sep 2026 08:25Z
    const decoded = decodeMetar('ESMS 140820Z 26008KT 9999 SCT012 14/13 Q1021', ref)
    expect(decoded.obsMs).toBe(Date.UTC(2026, 8, 14, 8, 20))
  })
})
