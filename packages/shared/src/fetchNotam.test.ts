import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchNotams, NotamNoIcaoError } from './fetchNotam'

describe('fetchNotams', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('does not call the API for a pseudo-ICAO the server would 400', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchNotams('ESTAGA')).rejects.toBeInstanceOf(NotamNoIcaoError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('trims and upper-cases like the server before the check', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ notams: [] }) }))
    vi.stubGlobal('fetch', fetchMock)
    await fetchNotams(' esms ', 'https://x')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://x/api/notam?icao=ESMS')
  })

  it('requests a real 4-letter ICAO', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ notams: [] }) }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchNotams('ESMS', 'https://x')).resolves.toEqual({ notams: [] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
