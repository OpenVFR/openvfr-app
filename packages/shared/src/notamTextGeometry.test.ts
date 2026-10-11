import { describe, it, expect } from 'vitest'
import { notamTextGeometry, normalizeNotamText, pointInNotamArea, hasNotamArea } from './notamTextGeometry'

// Real NOTAM texts (NMS-API, AIRAC 2610), line breaks as received.
const DE_NVG = "MON-THU, DAILY SS+30 - 23:00, EXCEPT GERMAN HOLIDAYS NVG\nTRAINING OF MIL HELICOPTERS WITH LIGHT AMPLIFYING DEVICES DISPLAYING \nNO OR MNM LIGHTING TO AND WI FOLLOWING BALTIC SEA AREA: 545000N010000\n0E-543000N0120000E-545500N0125000E-545500N0142200E-534000N0142200E-54\n2700N0130000E-540000N0105000E-542400N0110700E-541900N0104200E-543200N\n0100000E\n-545000N0100000E ONLY WITHIN GERMAN TERRITORY. AIRSPACE CAT C/D AND \nALL ED-R ARE EXCLUDED."
const DE_Q = { lat: 54.3, lon: 12 + 11 / 60, radiusNm: 85 }

const NL_ARC = "TEMPORARY RESTRICTED AREA 'CBA NORTH FULL A' ACTIVATED FOR EXER\r\nTACDAYS.\r\nAREA: 550000N 0050000E - 550000N 0053400E - 550000N 0063000E -\r\n544000N 0063000E - 543000N 0063000E - 541500N 0063000E - 540000N\r\n0063000E - 535002N 0063000E - 534000N 0063000E - 533000N 0053400E -\r\n532624N 0051000E - 532229N 0045220E ALONG A COUNTER CLOCKWISE ARC\r\n(RADIUS 8NM WITH CENTRE 531500N 0045700E) TO 531500N 0044341E -\r\n531500N 0043701E ALONG A COUNTER CLOCKWISE ARC (RADIUS 12NM WITH\r\nCENTRE 531500N 0045700E) TO 531106N 0043808E - 530917N 0044028E -\r\n530610N 0043056E - 530500N 0042100E - 525121N 0042100E - 530449N\r\n0034748E - 533135N 0034007E - 540000N 0040505E - 543000N 0043209E\r\nBACK TO 550000N 0050000E.\r\nAREA PROHIBITED."

describe('normalizeNotamText', () => {
  it('joins coordinates split by a line break, keeps words apart', () => {
    expect(normalizeNotamText('545000N010000\n0E WITH\r\nCENTRE')).toBe('545000N0100000E WITH CENTRE')
  })
})

describe('notamTextGeometry', () => {
  it('German Baltic NVG area: polygon from the text, not the 85 NM Q circle', () => {
    const g = notamTextGeometry(DE_NVG, DE_Q)
    expect(g.polygon?.type).toBe('Polygon')
    const ring = g.polygon!.type === 'Polygon' ? g.polygon!.coordinates[0]! : []
    expect(ring).toHaveLength(11)
    expect(Math.max(...ring.map(p => p[1]!))).toBeCloseTo(54 + 55 / 60, 5) // stays south of Sweden
  })

  it('polygon with arcs and BACK TO is one ring, arcs densified', () => {
    const g = notamTextGeometry(NL_ARC, null)
    expect(g.polygon?.type).toBe('Polygon')
    const ring = g.polygon!.type === 'Polygon' ? g.polygon!.coordinates[0]! : []
    expect(ring.length).toBeGreaterThan(25)
    expect(ring[0]).toEqual(ring[ring.length - 1])
    // the arc centre is not a vertex
    expect(ring.some(([lon, lat]) => Math.abs(lat! - 53.25) < 1e-6 && Math.abs(lon! - (4 + 57 / 60)) < 1e-6)).toBe(false)
  })

  it('space-separated vertex list (no dashes)', () => {
    const t = 'TEMPORARY RESTRICTED AREA IMPLEMENTED AS FOLLOW: 455447N0133533E-455443N0133643E-455359N0133631E 455356N0133619E-455359N0133512E-455447N0133533E /GORIZIA AD-LIPG/'
    const g = notamTextGeometry(t, { lat: 45.9, lon: 13.6, radiusNm: 1 })
    expect(g.polygon?.type).toBe('Polygon')
  })

  it('circle: "0.5NM RADIUS OF <coord>"', () => {
    const g = notamTextGeometry('FIREWORKS WI 0.5NM RADIUS OF 514508N 0013515W (BRIZE NORTON).', { lat: 51.75, lon: -1.5833, radiusNm: 1 })
    expect(g.circle).toEqual({ lat: expect.closeTo(51.7522, 3), lon: expect.closeTo(-1.5875, 3), radiusNm: 0.5 })
  })

  it('circle: "RADIUS 1.5NM CENTERED ON <coord>"', () => {
    const g = notamTextGeometry('GLIDER AEROBATICS RADIUS 1.5NM CENTERED ON 521015N 0101858E, AM SALZGITTERSEE', null)
    expect(g.circle?.radiusNm).toBe(1.5)
  })

  it('circle in metres', () => {
    const g = notamTextGeometry('UAS OPS WI 500M RADIUS OF PSN 591500N 0180000E', null)
    expect(g.circle?.radiusNm).toBeCloseTo(0.27, 2)
  })

  it('precise position: "PSN <coord>"', () => {
    const g = notamTextGeometry('MOBILE CRANE ERECTED AT PSN 481149N0105237E, MAX HEIGHT 94FT', { lat: 48.1833, lon: 10.8667, radiusNm: 5 })
    expect(g.point).toEqual({ lat: expect.closeTo(48.1969, 3), lon: expect.closeTo(10.8769, 3) })
  })

  it('ignores text geometry far outside the Q-line circle', () => {
    const g = notamTextGeometry('PSN 481149N0105237E', { lat: 59.65, lon: 17.93, radiusNm: 5 })
    expect(g.point).toBeNull()
  })

  it('several circles: none chosen (the Q envelope stays)', () => {
    const g = notamTextGeometry('KITES 1NM RADIUS OF 513706N 0073009E AND 1NM RADIUS OF 514000N 0073500E', null)
    expect(g).toEqual({ polygon: null, circle: null, point: null })
  })

  it('no geometry in plain text', () => {
    expect(notamTextGeometry('RESTRICTED AREA EDR54 (LEHNIN) ADDN ACT.', null)).toEqual({ polygon: null, circle: null, point: null })
  })
})

describe('pointInNotamArea', () => {
  const g = notamTextGeometry(DE_NVG, DE_Q)
  const n = { polygon: g.polygon, lat: null, lon: null, radiusNm: null }
  it('uses the polygon when present', () => {
    expect(pointInNotamArea(54.7, 12.5, n)).toBe(true)   // in the area
    expect(pointInNotamArea(55.4, 13.2, n)).toBe(false)  // Skane coast, inside the old 85 NM circle
  })
  it('falls back to the circle', () => {
    expect(pointInNotamArea(59.65, 17.93, { lat: 59.65, lon: 17.92, radiusNm: 1 })).toBe(true)
    expect(hasNotamArea({ lat: 59.65, lon: 17.92, radiusNm: null })).toBe(false)
  })
})
