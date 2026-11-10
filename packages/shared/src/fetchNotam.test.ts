import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchNotams } from './fetchNotam'

describe('fetchNotams', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('does not call the API for a pseudo-ICAO the server would 400', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchNotams('ESTAGA')).rejects.toThrow(/not an ICAO code/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requests a real 4-letter ICAO', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ notams: [] }) }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchNotams('ESMS', 'https://x')).resolves.toEqual({ notams: [] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
