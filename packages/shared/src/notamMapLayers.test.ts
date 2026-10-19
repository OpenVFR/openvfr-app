import { describe, it, expect } from 'vitest'
import type { FeatureCollection } from 'geojson'
import type { NotamItem } from './fetchNotam'
import { buildAirspaceIndex, matchNotamsToAirspace, notamMapFeatures, matchedAirspaceFeatures, notamsInWindow } from './notamMapLayers'
import { extractDesignators } from './notamDesignator'

const sq = (x: number): GeoJSON.Polygon => ({ type: 'Polygon', coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]] })
const area = (name: string, cls: string, x: number): GeoJSON.Feature => ({ type: 'Feature', geometry: sq(x), properties: { name, class: cls } })

const AIRSPACE: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    area('ESD873 OPTAND', 'D', 0),
    area('ESR22A VATTERN', 'R', 2),
    area('ESR22B VATTERN', 'R', 4),
    area('ESR1 ESRANGE', 'R', 6),
    area('STOCKHOLM CTR', 'C', 8),
  ],
}

const notam = (nmsId: string, text: string, over: Partial<NotamItem> = {}): NotamItem => ({
  id: nmsId, nmsId, text, effective: null, expires: null, classification: null, icaoLocation: null,
  polygon: null, lat: 60, lon: 15, radiusNm: 14, ...over,
})

describe('designators with a sector letter', () => {
  it('extracts ESR15A / EFR143B', () => {
    expect(extractDesignators('EFR143A EFR143B POHJANKANGAS ACT')).toEqual(['EFR143A', 'EFR143B'])
    expect(extractDesignators('ESR15A VADDO')).toEqual(['ESR15A'])
  })
})

describe('buildAirspaceIndex', () => {
  it('keeps only charted R/D/TRA areas with a designator in their name', () => {
    expect(buildAirspaceIndex(AIRSPACE).map(e => e.designator)).toEqual(['ESD873', 'ESR22A', 'ESR22B', 'ESR1'])
  })
})

describe('matchNotamsToAirspace', () => {
  const index = buildAirspaceIndex(AIRSPACE)

  it('matches a designator and hides its circle', () => {
    const n = notam('a', 'DANGER AREA ESD873 OPTAND ACT')
    const r = matchNotamsToAirspace(index, [n])
    expect(r.matches.map(m => m.airspaceName)).toEqual(['ESD873 OPTAND'])
    expect(r.matchedNotamIds.has('a')).toBe(true)
  })

  it('a sector-less designator covers every charted sector', () => {
    const r = matchNotamsToAirspace(index, [notam('b', 'RESTRICTED AREA ESR22 ACT')])
    expect(r.matches.map(m => m.airspaceName).sort()).toEqual(['ESR22A VATTERN', 'ESR22B VATTERN'])
  })

  it('an exact sector matches only itself', () => {
    const r = matchNotamsToAirspace(index, [notam('c', 'ESR22B ACT')])
    expect(r.matches.map(m => m.airspaceName)).toEqual(['ESR22B VATTERN'])
  })

  it('partly charted NOTAM is attached but keeps its circle', () => {
    const r = matchNotamsToAirspace(index, [notam('d', 'ESD873 AND ESD999 ACT')])
    expect(r.matches).toHaveLength(1)
    expect(r.matchedNotamIds.has('d')).toBe(false)
  })

  it('uncharted designator or no designator: no match', () => {
    const r = matchNotamsToAirspace(index, [notam('e', 'EFR143A ACT'), notam('f', 'RWY 12/30 CLSD')])
    expect(r.matches).toEqual([])
    expect(r.matchedNotamIds.size).toBe(0)
  })

  it('groups several NOTAMs on one area, deduped by nmsId', () => {
    const r = matchNotamsToAirspace(index, [notam('g1', 'ESD873 ACT'), notam('g2', 'ESD873 ACT 2'), notam('g1', 'ESD873 ACT')])
    expect(r.matches[0]!.notams.map(n => n.nmsId)).toEqual(['g1', 'g2'])
  })
})

describe('notamMapFeatures', () => {
  const poly = sq(10)
  const items = [
    notam('circle', 'X', { radiusNm: 5 }),
    notam('hidden', 'ESD873', { radiusNm: 5 }),
    notam('poly', 'Y', { polygon: poly, lat: null, lon: null, radiusNm: null }),
    notam('pt', 'Z', { radiusNm: null }),
    notam('nogeo', 'W', { lat: null, lon: null, radiusNm: null }),
  ]
  const f = notamMapFeatures(items, new Set(['hidden']))

  it('splits into circles / polygons / points, hiding matched circles', () => {
    expect(f.circles.map(c => c.properties!['nmsId'])).toEqual(['circle'])
    expect(f.polygons.map(c => c.properties!['nmsId'])).toEqual(['poly'])
    expect(f.points.map(c => c.properties!['nmsId'])).toEqual(['pt'])
  })
  it('a matched NOTAM with a real polygon still draws its polygon', () => {
    const g = notamMapFeatures([notam('p2', 'ESD873', { polygon: poly, lat: null, lon: null, radiusNm: null })], new Set(['p2']))
    expect(g.polygons).toHaveLength(1)
  })
  it('highlight features carry the charted name', () => {
    const r = matchNotamsToAirspace(buildAirspaceIndex(AIRSPACE), [notam('a', 'ESD873')])
    expect(matchedAirspaceFeatures(r.matches)[0]!.properties).toEqual({ name: 'ESD873 OPTAND' })
  })
})

describe('notamsInWindow', () => {
  const sched = (text: string) => notam('s', text, { lat: 54.3, lon: 12.2, radiusNm: null, effective: '2026-10-01T00:00:00Z' })
  const nvg = sched('MON-THU, DAILY SS+30 - 23:00, EXCEPT GERMAN HOLIDAYS NVG TRAINING')
  const plain = notam('p', 'UAS OPERATION')
  it('drops a NOTAM that is off schedule for the whole window, keeps the rest', () => {
    const mon0624 = Date.parse('2026-10-19T06:24:00Z')
    expect(notamsInWindow([nvg, plain], mon0624, mon0624 + 3 * 3_600_000).map(n => n.nmsId)).toEqual(['p'])
    const mon19 = Date.parse('2026-10-19T19:00:00Z')
    expect(notamsInWindow([nvg, plain], mon19, mon19 + 3_600_000)).toHaveLength(2)
  })
})

describe('obstacle NOTAMs', () => {
  it('go to their own zoom-gated list, not the clustered points', () => {
    const f = notamMapFeatures([
      notam('o1', 'OBST LGT WINDMILL U/S', { qCode: 'QOLAS', radiusNm: null }),
      notam('o2', 'CRANE', { qCode: 'QOBCE', radiusNm: null }),
      notam('n1', 'VOR U/S', { qCode: 'QNVAS', radiusNm: null }),
    ], new Set())
    expect(f.obstacles.map(x => x.properties!['nmsId'])).toEqual(['o1', 'o2'])
    expect(f.points.map(x => x.properties!['nmsId'])).toEqual(['n1'])
  })
})
