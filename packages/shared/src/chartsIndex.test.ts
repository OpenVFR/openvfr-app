import { describe, it, expect } from 'vitest'
import {
  parseChartsIndex, chartsForAerodrome, overlayGeometry, chartDocumentProxyUrl, chartDocumentHosts,
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
    expect(charts.map(c => c.id)).toEqual(['b', 'a', 'z'])
    expect(charts[2]!.kind).toBe('OTHER')
    expect(charts[1]!.georef?.crop).toEqual(crop)
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
    expect(ad.charts.map(c => c.kind)).toEqual(['VAC', 'IAC', 'OTHER'])
    expect(ad.display.overlay).toBe(true)
    expect(chartsForAerodrome([idx], 'YYYY')).toBeNull()
  })

  it('overlays the map frame when known, else the page', () => {
    const g = idx.aerodromes['XXTT']!.charts.find(c => c.id === 'a')!.georef!
    expect(overlayGeometry(g)).toEqual({ corners: cropCorners, crop })
    expect(overlayGeometry({ ...g, crop: undefined, crop_corners: undefined })).toEqual({ corners, crop: [0, 0, 1, 1] })
  })

  it('builds the pass-through URL and host list', () => {
    expect(chartDocumentProxyUrl('', 'https://aip.example/a b.pdf'))
      .toBe('/api/charts/document?url=https%3A%2F%2Faip.example%2Fa%20b.pdf')
    expect(chartDocumentHosts(idx)).toEqual(['aip.example', 'other.example'])
  })
})
