import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { loadChartsIndexes, closeUnreleasedCharts, chartUi, getChartUiState, type ChartSelection } from './charts'

const index = (ids: string[]) => ({
  schema: 'openvfr.charts/1', country: 'zz', cycle: '2026-10-29', source: { name: 'AIP', url: 'https://aip.example.org/' },
  display: { document: true, overlay: true },
  aerodromes: { ZZTT: { name: 'T', charts: ids.map(id => ({ id, title: id, kind: 'VAC', url: `https://aip.example.org/${id}.pdf` })) } },
})
const ID_A = 'a'.repeat(12)   // chart ids are hashes
const ID_B = 'b'.repeat(12)

/** fetch answering by file name: status per file ('public' / 'preview'). */
function stubFetch(answers: { public?: number | unknown; preview?: number | unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const kind = String(url).includes('charts.preview.json') ? 'preview' : String(url).includes('charts.public.json') ? 'public' : null
    const a = kind ? answers[kind] : undefined
    if (typeof a === 'number') return new Response('x', { status: a })
    return a === undefined ? new Response('x', { status: 404 }) : Response.json(a)
  }))
}

describe('charts indexes', () => {
  afterEach(() => { vi.unstubAllGlobals(); chartUi.closeOverlay(); chartUi.closeViewer() })

  it('a normal session reads the public index only', async () => {
    stubFetch({ public: index([ID_A]), preview: index([ID_A, ID_B]) })
    const r = await loadChartsIndexes('z1', false)
    expect(Object.keys(r.index?.aerodromes ?? {})).toEqual(['ZZTT'])
    expect(r.index?.aerodromes['ZZTT']?.charts).toHaveLength(1)
    expect(r.previewFailed).toBe(false)
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(c => String(c[0]).includes('charts.preview.json'))).toBe(false)
  })

  it('an admin with unreviewed on reads the preview index and keeps the public one to tell what is not released', async () => {
    stubFetch({ public: index([ID_A]), preview: index([ID_A, ID_B]) })
    const r = await loadChartsIndexes('z2', true)
    expect(r.index?.aerodromes['ZZTT']?.charts).toHaveLength(2)
    expect(r.publicIndex?.aerodromes['ZZTT']?.charts).toHaveLength(1)
    expect(r.previewFailed).toBe(false)
  })

  it('a preview index that is not published falls back to the public one without a warning', async () => {
    stubFetch({ public: index([ID_A]) })                         // preview: 404, a definite "not there"
    const r = await loadChartsIndexes('z3', true)
    expect(r.index?.aerodromes['ZZTT']?.charts).toHaveLength(1)
    expect(r.previewFailed).toBe(false)
  })

  it('a preview index that fails to load (server error) falls back but says so', async () => {
    stubFetch({ public: index([ID_A]), preview: 500 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await loadChartsIndexes('z4', true)
    expect(r.index?.aerodromes['ZZTT']?.charts).toHaveLength(1)
    expect(r.previewFailed).toBe(true)
    warn.mockRestore()
  })
})

describe('closing unreleased charts when unreviewed data turns off', () => {
  const sel = (id: string): ChartSelection => ({
    country: 'z5', icao: 'ZZTT', attribution: 'AIP', cycle: null,
    chart: { id, title: id, kind: 'VAC', url: `https://aip.example.org/${id}.pdf` } as ChartSelection['chart'],
  })
  beforeEach(() => stubFetch({ public: { ...index([ID_A]), country: 'z5' } }))
  afterEach(() => { vi.unstubAllGlobals(); chartUi.closeOverlay(); chartUi.closeViewer() })

  it('closes the overlay and the viewer for a chart the public index does not list, keeps a released one', async () => {
    chartUi.showOverlay(sel(ID_B))                               // an unreleased chart on the map
    chartUi.openViewer(sel(ID_A))                                // a released one in the viewer
    await closeUnreleasedCharts()
    expect(getChartUiState().overlay).toBeNull()
    expect(getChartUiState().viewer?.chart.id).toBe(ID_A)
  })

  it('closes an unreleased chart in the viewer too, and does nothing when nothing is open', async () => {
    await closeUnreleasedCharts()
    expect(getChartUiState().viewer).toBeNull()
    chartUi.openViewer(sel(ID_B))
    await closeUnreleasedCharts()
    expect(getChartUiState().viewer).toBeNull()
  })
})
