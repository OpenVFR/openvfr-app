import { describe, it, expect } from 'vitest'
import {
  parseChartsIndex, chartsForAerodrome, overlayGeometry, chartDocumentProxyUrl, chartDocumentHosts, findChart,
} from './chartsIndex'

const corners = [[12.4, 57.0], [13.3, 57.0], [13.3, 56.4], [12.4, 56.4]]
const crop = [0.03, 0.11, 0.97, 0.77]
const cropCorners = [[12.45, 56.95], [13.25, 56.95], [13.25, 56.5], [12.45, 56.5]]

function sample(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'openvfr.charts/1',
    country: 'XX',
    cycle: '2026-01-22',
    source: { name: 'Example AIP', url: 'https://aip.example/', attribution: '(c) Example' },
    display: { document: true, overlay: true },
    aerodromes: {
      XXTT: {
        name: 'Testville',
        info_url: 'https://aip.example/ad2/XXTT.html',
        charts: [
          { id: 'b', title: 'Instrument approach RWY 27', kind: 'IAC', url: 'https://aip.example/iac.pdf' },
          { id: 'a', title: 'VAC', kind: 'VAC', url: 'https://aip.example/vac.pdf',
            georef: { method: 'graticule', page: 1, page_size_pt: [595, 842], corners, crop, crop_corners: cropCorners, accuracy_m: 350 } },
          { id: 'x', title: 'Not https', kind: 'ADC', url: 'http://aip.example/adc.pdf' },
          { id: 'y', title: 'Script', kind: 'ADC', url: 'javascript:alert(1)' },
          { id: 'z', title: 'Odd kind', kind: 'WHATEVER', url: 'https://other.example/z.pdf' },
          { id: 'bad/id', title: 'Id unfit for a path', kind: 'ADC', url: 'https://aip.example/q.pdf' },
          { id: 'e', key: 'XXTT-adc-adc', title: 'ADC', kind: 'ADC', url: 'https://aip.example/adc2.pdf',
            effective: '2026-01-22', sha256: 'a'.repeat(64), bytes: 123456 },
          { id: 'f', key: 'has space', title: 'Bad edition data', kind: 'ADC', url: 'https://aip.example/adc3.pdf',
            effective: '22 Jan', sha256: 'xyz', bytes: -1 },
        ],
      },
      'not an icao': { charts: [] },
    },
    ...overrides,
  }
}

describe('parseChartsIndex', () => {
  it('keeps valid https charts, normalises kind, drops bad entries', () => {
    const idx = parseChartsIndex(sample())!
    expect(idx.country).toBe('xx')
    expect(Object.keys(idx.aerodromes)).toEqual(['XXTT'])
    const charts = idx.aerodromes['XXTT']!.charts
    expect(charts.map(c => c.id)).toEqual(['b', 'a', 'z', 'e', 'f'])
    expect(charts[2]!.kind).toBe('OTHER')
    expect(charts[1]!.georef?.crop).toEqual(crop)
  })

  it('keeps edition data only when well-formed', () => {
    const charts = parseChartsIndex(sample())!.aerodromes['XXTT']!.charts
    const e = charts.find(c => c.id === 'e')!
    expect([e.key, e.effective, e.sha256, e.bytes]).toEqual(['XXTT-adc-adc', '2026-01-22', 'a'.repeat(64), 123456])
    const f = charts.find(c => c.id === 'f')!
    expect([f.key, f.effective, f.sha256, f.bytes]).toEqual([undefined, undefined, undefined, undefined])
  })

  it('rejects files that are not a charts index', () => {
    expect(parseChartsIndex(null)).toBeNull()
    expect(parseChartsIndex({ type: 'FeatureCollection' })).toBeNull()
  })

  it('drops georeferences when the source does not allow overlays', () => {
    const idx = parseChartsIndex(sample({ display: { document: true, overlay: false } }))!
    expect(idx.aerodromes['XXTT']!.charts.every(c => !c.georef)).toBe(true)
  })

  it('ignores a malformed georef but keeps the chart', () => {
    const raw = sample()
    ;(raw.aerodromes.XXTT.charts[1] as Record<string, unknown>)['georef'] = { corners: [[1, 2]] }
    const c = parseChartsIndex(raw)!.aerodromes['XXTT']!.charts.find(c => c.id === 'a')!
    expect(c.georef).toBeUndefined()
  })
})

describe('helpers', () => {
  const idx = parseChartsIndex(sample())!

  it('sorts VFR charts first', () => {
    const ad = chartsForAerodrome([idx], 'XXTT')!
    expect(ad.charts.map(c => c.kind)).toEqual(['VAC', 'ADC', 'ADC', 'IAC', 'OTHER'])
    expect(ad.country).toBe('xx')
    expect(ad.display.overlay).toBe(true)
    expect(chartsForAerodrome([idx], 'YYYY')).toBeNull()
  })

  it('overlays the map frame when known, else the page', () => {
    const g = idx.aerodromes['XXTT']!.charts.find(c => c.id === 'a')!.georef!
    expect(overlayGeometry(g)).toEqual({ corners: cropCorners, crop })
    expect(overlayGeometry({ ...g, crop: undefined, crop_corners: undefined })).toEqual({ corners, crop: [0, 0, 1, 1] })
  })

  it('builds the pass-through URL from country and chart id, and the host list', () => {
    expect(chartDocumentProxyUrl('', 'xx', 'a')).toBe('/api/charts/document/xx/a')
    expect(chartDocumentProxyUrl('https://api.example', 'xx', 'a_b-1')).toBe('https://api.example/api/charts/document/xx/a_b-1')
    expect(chartDocumentHosts(idx)).toEqual(['aip.example', 'other.example'])
  })

  it('finds a chart by edition id', () => {
    expect(findChart(idx, 'a')).toMatchObject({ icao: 'XXTT', chart: { url: 'https://aip.example/vac.pdf' } })
    expect(findChart(idx, 'nope')).toBeNull()
  })
})
