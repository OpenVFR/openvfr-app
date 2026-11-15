/**
 * The native chart logic against an in-memory file system (no device): index loading and its failure handling, the checks on a
 * document download, the document cache and its eviction, the render cache. The native modules are mocked; what they do on a device
 * is not covered here (that is the PdfRenderer / PDFKit side).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── in-memory expo-file-system ──────────────────────────────────────────────
const disk = new Map<string, Uint8Array>()
let downloadBytes: Uint8Array = new Uint8Array(0)
let downloadFails = false
let downloads: string[] = []

vi.mock('expo-file-system', () => {
  const join = (...p: Array<string | { uri: string }>) => { const [head, ...rest] = p.map(x => (typeof x === 'string' ? x : x.uri)); return [head.replace(/\/+$/, ''), ...rest.map(r => r.replace(/^\/+|\/+$/g, ''))].join('/') }
  class Directory {
    uri: string
    constructor(...p: Array<string | { uri: string }>) { this.uri = join(...p) }
    get exists() { return [...disk.keys()].some(k => k.startsWith(this.uri + '/')) || disk.has(this.uri + '/.dir') }
    create() { disk.set(this.uri + '/.dir', new Uint8Array(0)) }
    list() {
      const names = new Set<string>()
      for (const k of disk.keys()) if (k.startsWith(this.uri + '/') && !k.endsWith('/.dir')) names.add(k.slice(this.uri.length + 1).split('/')[0])
      return [...names].map(n => new File(this, n))
    }
    delete() { for (const k of [...disk.keys()]) if (k.startsWith(this.uri + '/')) disk.delete(k) }
  }
  class File {
    uri: string
    name: string
    constructor(...p: Array<string | { uri: string }>) { this.uri = join(...p); this.name = this.uri.split('/').pop()! }
    get exists() { return disk.has(this.uri) }
    get size() { return disk.get(this.uri)?.byteLength ?? 0 }
    delete() { disk.delete(this.uri) }
    write(t: string) { disk.set(this.uri, new TextEncoder().encode(t)) }
    textSync() { return new TextDecoder().decode(disk.get(this.uri)) }
    open() {
      const bytes = disk.get(this.uri)!
      return { readBytesSync: (n: number) => bytes.slice(0, n), close() {} }
    }
    static createDownloadTask(url: string, dest: File, opts?: { signal?: AbortSignal; onProgress?: (p: { bytesWritten: number; totalBytes: number }) => void }) {
      return {
        async downloadAsync() {
          downloads.push(url)
          if (downloadFails) throw new Error('network')
          opts?.onProgress?.({ bytesWritten: downloadBytes.byteLength, totalBytes: downloadBytes.byteLength })
          if (opts?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
          disk.set(dest.uri, downloadBytes)
          return dest
        },
      }
    }
  }
  return { File, Directory, Paths: { cache: { uri: 'file:///cache' }, document: { uri: 'file:///doc' } }, FileMode: { ReadOnly: 'r' } }
})

vi.mock('../config', () => ({ API_BASE: 'https://api.example', tileFileUrlReady: async (n: string) => `https://tiles.example/${n}` }))

const pdfNative = {
  pageInfo: vi.fn(async (_u: string, _p: number) => ({ pageCount: 3, widthPt: 595, heightPt: 842 })),
  renderPage: vi.fn(async (_u: string, _p: number, w: number, h: number, _c: number[], out: string) => ({ uri: out, width: w, height: h, pageWidthPt: 595, pageHeightPt: 842 })),
}
vi.mock('../../modules/openvfr-pdf', () => ({ OpenVfrPdf: pdfNative }))

const PDF = new TextEncoder().encode('%PDF-1.7 body')

function indexJson(charts: Array<Record<string, unknown>>, display = { document: true, overlay: true }) {
  return {
    schema: 'openvfr.charts/1', country: 'se', cycle: '2026-10-29', source: { name: 'LFV', url: 'https://aro.lfv.se/', attribution: 'LFV' },
    display, aerodromes: { ESMS: { name: 'Malmo', charts } },
  }
}
const chart = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, kind: 'VAC', url: `https://aro.lfv.se/${id}.pdf`, ...extra })

let indexBody: unknown = indexJson([chart('vac1')])
let indexStatus = 200
let fetchCalls: string[] = []

beforeEach(() => {
  disk.clear(); downloads = []; fetchCalls = []; downloadFails = false; downloadBytes = PDF
  indexBody = indexJson([chart('vac1')]); indexStatus = 200
  pdfNative.pageInfo.mockClear(); pdfNative.renderPage.mockClear()
  vi.resetModules()
  globalThis.fetch = (async (input: unknown) => {
    const u = String(input)
    fetchCalls.push(u)
    if (u.includes('se-charts.public.json')) return new Response(JSON.stringify(indexBody), { status: indexStatus })
    return new Response('nope', { status: 404 })
  }) as typeof fetch
})

const load = () => import('./charts')
const sel = (id: string) => ({ chart: { id } as never, country: 'se', icao: 'ESMS', attribution: 'LFV', cycle: null })

describe('the public index only', () => {
  it('reads the public file and never a preview file', async () => {
    const m = await load()
    expect(await m.loadChartsIndex('se')).not.toBeNull()
    expect(fetchCalls).toEqual(['https://tiles.example/se-charts.public.json'])
    expect(fetchCalls.some(u => u.includes('preview'))).toBe(false)
  })
  it('a missing index (4xx) is remembered, an error is retried', async () => {
    indexStatus = 404
    let m = await load()
    expect(await m.loadChartsIndex('se')).toBeNull()
    await m.loadChartsIndex('se')
    expect(fetchCalls.length).toBe(1)                                   // 404 remembered
    vi.resetModules(); fetchCalls = []; indexStatus = 503
    m = await load()
    expect(await m.loadChartsIndex('se')).toBeNull()
    indexStatus = 200
    expect(await m.loadChartsIndex('se')).not.toBeNull()                // 503 not remembered: retried
    expect(fetchCalls.length).toBe(2)
  })
})

describe('ensureChartDocument', () => {
  it('downloads the document from the URL in the index, validates it and caches it', async () => {
    const m = await load()
    const uri = await m.ensureChartDocument(sel('vac1'))
    expect(uri).toBe('file:///cache/ovfr-charts/se-vac1.pdf')
    expect(downloads).toEqual(['https://aro.lfv.se/vac1.pdf'])          // the index's URL, not anything from the selection
    expect(await m.ensureChartDocument(sel('vac1'))).toBe(uri)
    expect(downloads.length).toBe(1)                                    // second open: from the cache
  })

  it('two opens at once share one download', async () => {
    const m = await load()
    const [a, b] = await Promise.all([m.ensureChartDocument(sel('vac1')), m.ensureChartDocument(sel('vac1'))])
    expect(a).toBe(b)
    expect(downloads.length).toBe(1)
  })

  it('refuses a chart the index does not list, or when documents are not displayable', async () => {
    let m = await load()
    await expect(m.ensureChartDocument(sel('nope'))).rejects.toThrow(/not available/)
    indexBody = indexJson([chart('vac1')], { document: false, overlay: false })
    vi.resetModules(); m = await load()
    await expect(m.ensureChartDocument(sel('vac1'))).rejects.toThrow(/not available/)
    expect(downloads.length).toBe(0)
  })

  it('refuses a URL that fails the checks (http, credentials, port, not a pdf)', async () => {
    for (const url of ['http://aro.lfv.se/x.pdf', 'https://u:p@aro.lfv.se/x.pdf', 'https://aro.lfv.se:8443/x.pdf', 'https://aro.lfv.se/x.html']) {
      indexBody = indexJson([chart('vac1', { url })])
      vi.resetModules()
      const m = await load()
      // parseChartsIndex already drops http; the rest reach the check
      await expect(m.ensureChartDocument(sel('vac1'))).rejects.toThrow(/cannot be opened|not available/)
    }
    expect(downloads.length).toBe(0)
  })

  it('deletes and refuses a download that is not a PDF, empty, or not the edition the index lists', async () => {
    let m = await load()
    downloadBytes = new TextEncoder().encode('<html>login</html>')
    await expect(m.ensureChartDocument(sel('vac1'))).rejects.toThrow(/not valid/)
    expect(disk.has('file:///cache/ovfr-charts/se-vac1.pdf')).toBe(false)

    downloadBytes = new Uint8Array(0)
    vi.resetModules(); m = await load()
    await expect(m.ensureChartDocument(sel('vac1'))).rejects.toThrow(/not valid/)
    expect(disk.has('file:///cache/ovfr-charts/se-vac1.pdf')).toBe(false)

    indexBody = indexJson([chart('vac1', { bytes: 999 })])             // the index says 999 bytes, we got fewer
    downloadBytes = PDF
    vi.resetModules(); m = await load()
    await expect(m.ensureChartDocument(sel('vac1'))).rejects.toThrow(/not valid/)
    expect(disk.has('file:///cache/ovfr-charts/se-vac1.pdf')).toBe(false)
  })

  it('a failed download leaves nothing behind and says so plainly', async () => {
    downloadFails = true
    const m = await load()
    await expect(m.ensureChartDocument(sel('vac1'))).rejects.toThrow(/could not be downloaded/)
    expect(disk.has('file:///cache/ovfr-charts/se-vac1.pdf')).toBe(false)
    downloadFails = false
    expect(await m.ensureChartDocument(sel('vac1'))).toContain('se-vac1.pdf')      // and the next try works
  })

  it('re-downloads a cached copy that is damaged or no longer the listed edition', async () => {
    const m = await load()
    await m.ensureChartDocument(sel('vac1'))
    disk.set('file:///cache/ovfr-charts/se-vac1.pdf', new TextEncoder().encode('garbage'))     // damaged
    await m.ensureChartDocument(sel('vac1'))
    expect(downloads.length).toBe(2)
  })

  it('keeps at most 8 documents, dropping the least recently used', async () => {
    indexBody = indexJson(Array.from({ length: 10 }, (_, i) => chart(`c${i}`)))
    const m = await load()
    for (let i = 0; i < 10; i++) { await m.ensureChartDocument(sel(`c${i}`)); await new Promise(r => setTimeout(r, 2)) }
    const kept = [...disk.keys()].filter(k => k.endsWith('.pdf')).sort()
    expect(kept.length).toBe(8)
    expect(kept).not.toContain('file:///cache/ovfr-charts/se-c0.pdf')
    expect(kept).not.toContain('file:///cache/ovfr-charts/se-c1.pdf')
    expect(kept).toContain('file:///cache/ovfr-charts/se-c9.pdf')
  })
})

describe('renderChartPage', () => {
  it('draws through the native module at the requested width, capped, and caches the same request', async () => {
    const m = await load()
    const a = await m.renderChartPage('file:///cache/ovfr-charts/se-vac1.pdf', 1, 1000)
    expect(a.width).toBe(1000)
    expect(a.height).toBe(Math.floor(842 * (1000 / 595) + 1e-6))
    expect(a.pageCount).toBe(3)
    expect(pdfNative.renderPage).toHaveBeenCalledTimes(1)
    await m.renderChartPage('file:///cache/ovfr-charts/se-vac1.pdf', 1, 1000)
    expect(pdfNative.renderPage).toHaveBeenCalledTimes(1)               // same request: not drawn twice
    await m.renderChartPage('file:///cache/ovfr-charts/se-vac1.pdf', 2, 1000)
    expect(pdfNative.renderPage).toHaveBeenCalledTimes(2)               // another page is
    const huge = await m.renderChartPage('file:///cache/ovfr-charts/se-vac1.pdf', 1, 50000)
    expect(huge.width * huge.height).toBeLessThanOrEqual(16_000_000)    // never past the pixel cap
  })

  it('a crop is drawn at the crop size', async () => {
    const m = await load()
    const r = await m.renderChartPage('file:///cache/ovfr-charts/se-vac1.pdf', 1, 600, [0.1, 0.1, 0.9, 0.7])
    expect(pdfNative.renderPage.mock.calls.at(-1)![4]).toEqual([0.1, 0.1, 0.9, 0.7])
    expect(r.width).toBe(600)
  })

  it('a failed render is not remembered', async () => {
    const m = await load()
    pdfNative.renderPage.mockRejectedValueOnce(new Error('boom'))
    await expect(m.renderChartPage('file:///cache/ovfr-charts/se-x.pdf', 1, 500)).rejects.toThrow('boom')
    await expect(m.renderChartPage('file:///cache/ovfr-charts/se-x.pdf', 1, 500)).resolves.toBeTruthy()
  })
})

describe('chart UI state', () => {
  it('toggling the same chart removes it, a new one frames the map, opacity is clamped', async () => {
    const m = await load()
    const s = sel('vac1')
    expect(m.getChartUiState().fitToken).toBe(0)
    m.chartUi.toggleOverlay(s)
    expect(m.getChartUiState().overlay?.chart.id).toBe('vac1')
    expect(m.getChartUiState().fitToken).toBe(1)
    m.chartUi.toggleOverlay(s)
    expect(m.getChartUiState().overlay).toBeNull()
    expect(m.getChartUiState().fitToken).toBe(1)                        // removing does not re-frame
    m.chartUi.setOpacity(5); expect(m.getChartUiState().overlayOpacity).toBe(1)
    m.chartUi.setOpacity(0); expect(m.getChartUiState().overlayOpacity).toBe(0.1)
  })
})
