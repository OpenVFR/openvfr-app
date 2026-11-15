import { describe, it, expect } from 'vitest'
import {
  checkChartDocumentUrl, documentHostSet, chartDocumentFileName, documentsToEvict, looksLikePdf, cornersBounds, cornersVisible,
  renderSize, overlayAccuracyLabel, MAX_RENDER_PIXELS,
} from './chartDocument'
import { parseChartsIndex } from './chartsIndex'

const hosts = new Set(['aip.example.org'])

describe('checkChartDocumentUrl', () => {
  it('accepts an https PDF on a listed host and drops the fragment', () => {
    expect(checkChartDocumentUrl('https://aip.example.org/a/VAC%20ESMS.pdf#page=2', hosts)).toEqual({ url: 'https://aip.example.org/a/VAC%20ESMS.pdf' })
    expect(checkChartDocumentUrl('https://AIP.example.org/a.PDF', hosts)).toEqual({ url: 'https://aip.example.org/a.PDF' })
  })
  it('refuses anything else', () => {
    const err = (u: string | undefined) => (checkChartDocumentUrl(u, hosts) as { error: string }).error
    expect(err(undefined)).toMatch(/missing/)
    expect(err('http://aip.example.org/a.pdf')).toMatch(/https/)
    expect(err('https://user:pw@aip.example.org/a.pdf')).toMatch(/credentials/)
    expect(err('https://aip.example.org:8443/a.pdf')).toMatch(/port/)
    expect(err('https://evil.example/a.pdf')).toMatch(/host/)
    expect(err('https://aip.example.org/a.html')).toMatch(/PDF/)
    expect(err('https://aip.example.org/%E0%A4%A.pdf')).toMatch(/encoding/)
    expect(err('not a url')).toMatch(/not a URL/)
    expect(err('https://aip.example.org/' + 'a'.repeat(3000) + '.pdf')).toMatch(/too long/)
  })
})

describe('index hosts', () => {
  it('are the hostnames the index lists, lower-cased', () => {
    const idx = parseChartsIndex({ schema: 'openvfr.charts/1', country: 'xx', display: { document: true, overlay: false }, source: { name: 'S', url: 'https://x.example/', attribution: 'S' },
      aerodromes: { XXTT: { charts: [{ id: 'a1', title: 'A', kind: 'VAC', url: 'https://AIP.Example.org/a.pdf' }, { id: 'b1', title: 'B', kind: 'ADC', url: 'https://other.example/b.pdf' }] } } })!
    expect([...documentHostSet(idx)].sort()).toEqual(['aip.example.org', 'other.example'])
  })
})

describe('cache', () => {
  it('names one file per edition and refuses unsafe ids', () => {
    expect(chartDocumentFileName('se', { id: 'esms-vac_2610' })).toBe('se-esms-vac_2610.pdf')
    expect(chartDocumentFileName('SE', { id: 'a' })).toBeNull()
    expect(chartDocumentFileName('se', { id: '../x' })).toBeNull()
  })
  it('evicts the oldest beyond the keep count', () => {
    const files = [{ name: 'a', modified: 1 }, { name: 'b', modified: 5 }, { name: 'c', modified: 3 }, { name: 'd', modified: 4 }]
    expect(documentsToEvict(files, 2).sort()).toEqual(['a', 'c'])
    expect(documentsToEvict(files, 10)).toEqual([])
    expect(documentsToEvict(files, 0).sort()).toEqual(['a', 'b', 'c', 'd'])
  })
  it('recognises a PDF by its first bytes', () => {
    expect(looksLikePdf(new TextEncoder().encode('%PDF-1.7'))).toBe(true)
    expect(looksLikePdf(new TextEncoder().encode('<html>'))).toBe(false)
    expect(looksLikePdf(new Uint8Array(3))).toBe(false)
  })
})

describe('overlay geometry helpers', () => {
  const corners: [number, number][] = [[12.45, 56.95], [13.25, 56.95], [13.25, 56.5], [12.45, 56.5]]
  it('bounds and visibility', () => {
    expect(cornersBounds(corners)).toEqual({ sw: [12.45, 56.5], ne: [13.25, 56.95] })
    expect(cornersVisible(corners, { sw: [12.9, 56.6], ne: [13.0, 56.7] })).toBe(true)          // inside
    expect(cornersVisible(corners, { sw: [12.0, 56.0], ne: [14.0, 58.0] })).toBe(true)          // covers it
    expect(cornersVisible(corners, { sw: [14.0, 56.6], ne: [14.5, 56.7] })).toBe(false)         // beside it
  })
  it('accuracy label rounds to 50 m with a 100 m floor', () => {
    expect(overlayAccuracyLabel(30)).toBe('±100 m')
    expect(overlayAccuracyLabel(180)).toBe('±200 m')
    expect(overlayAccuracyLabel(undefined)).toBe('±? m')
  })
})

describe('renderSize', () => {
  it('fits the target width and keeps the page proportions', () => {
    const s = renderSize(595, 842, 1190)
    expect(s.width).toBe(1190)
    expect(s.height).toBe(Math.round(842 * 2))
  })
  it('a crop is sized from the crop, not the page', () => {
    const s = renderSize(1000, 1000, 500, [0.25, 0.25, 0.75, 0.75])
    expect([s.width, s.height]).toEqual([500, 500])
  })
  it('never exceeds the pixel cap, whatever is asked', () => {
    const s = renderSize(595, 842, 20000)
    expect(s.width * s.height).toBeLessThanOrEqual(MAX_RENDER_PIXELS)
    expect(renderSize(1, 1, 0.01).width).toBe(1)
  })
})
