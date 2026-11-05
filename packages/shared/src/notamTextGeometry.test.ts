import { describe, it, expect } from 'vitest'
import { notamTextGeometry, notamAreaQualifier, normalizeNotamText, pointInNotamArea, hasNotamArea } from './notamTextGeometry'

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
    const g = notamTextGeometry('PSN 481149N0105237E', { lat: 59.65, lon: 17.93, radiusNm: 5 }) // ~700 NM away
    expect(g.point).toBeNull()
  })

  it('several circles: one polygon each', () => {
    const g = notamTextGeometry('AREA 1: 1.45KM RADIUS OF 543954.00N 0251400.00E (VILKPEDE), AREA 2: 1.24KM RADIUS OF 544034.22N 0251538.37E', null)
    expect(g.polygon?.type).toBe('MultiPolygon')
    expect(g.polygon?.type === 'MultiPolygon' && g.polygon.coordinates).toHaveLength(2)
  })

  it('numbered vertex list ("1. c 2. c")', () => {
    const t = 'TEMPORARY RESERVED AREA EPTR427 ZEGRZE. LATERAL LIMITS: 1. 522747N 0210113E 2. 522831N 0210154E 3. 522909N 0205951E 4. 522823N 0205905E 5. 522804N 0205953E 1. 522747N 0210113E VERTICAL LIMITS: GND-1800FT AMSL.'
    const g = notamTextGeometry(t, { lat: 52.4667, lon: 21, radiusNm: 2 })
    expect(g.polygon?.type).toBe('Polygon')
  })

  it('"STATE BORDER" links between vertices', () => {
    const t = 'WITHIN AREA BOUNDED BY THE \nFOLLOWING COORD POINTS:\n483103N0205854E\nSTATE BORDER\n483018N0213612E\nSTATE BORDER\n472025N0215511E\nSTATE BORDER\n465307N0213518E\n483103N0205854E (AG-22 HIGH).'
    expect(notamTextGeometry(t, null).polygon?.type).toBe('Polygon')
  })

  it('circle: "CIRCLE RADIUS 2NM CENTERED ON POINT c", "1050M RADIUS CENTERED ON COORD: c", double spaces, "1NM AROUND c"', () => {
    expect(notamTextGeometry('LATERAL LIMITS: CIRCLE RADIUS 2NM CENTERED ON POINT 542119N 0185004E', null).circle?.radiusNm).toBe(2)
    expect(notamTextGeometry('WI 1050M RADIUS CENTERED ON COORD: 371242.7N 0064606.0W AREA', null).circle).not.toBeNull()
    expect(notamTextGeometry('WI 600M RADIUS CENTERED  ON 542132N\r\n0232633E (SESTOKAI)', null).circle).not.toBeNull()
    expect(notamTextGeometry('UAS ACTIVITY 1NM AROUND 541914N0093156E (HOHN)', null).circle?.radiusNm).toBe(1)
    expect(notamTextGeometry('AVOID ZWIGGELTE AT PSN 525358N 0063348E RADIUS 0,25NM.', null).circle?.radiusNm).toBe(0.25)
  })

  it('single bare coordinate is the position', () => {
    expect(notamTextGeometry('CAPTIVE BALLOON 514942N 0155831E - TARNOW UPPER LIMIT: 900FT AMSL', null).point).not.toBeNull()
    expect(notamTextGeometry('FIREWORKS DISPLAY AT COORD: 275505,30N 0152401,15W HEIGHT: 100M', null).point?.lat).toBeCloseTo(27.918, 3)
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

describe('notamTextGeometry: one coordinate scanner', () => {
  it('fixtures 6-9: notations in the text reach the geometry', () => {
    for (const c of ['593922N 0175612E', '59°39\'22"N 017°56\'12"E', '59 39 22 N 017 56 12 E', 'N593922 E0175612', '593922N 175612E']) {
      const g = notamTextGeometry(`CRANE PSN ${c} 90FT`, null)
      expect(g.point?.lat).toBeCloseTo(59.656111, 5)
      expect(g.point?.lon).toBeCloseTo(17.936667, 5)
    }
    const d = notamTextGeometry('1 NM RADIUS OF 5939.5N 01756.2E', null)
    expect(d.circle?.lat).toBeCloseTo(59.658333, 5)
  })
  it('fixture 10: minutes >= 60 never become geometry', () => {
    expect(notamTextGeometry('PSN 596122N 0175612E', null).point).toBeNull()
  })
  it('fixture 19: coordinate split by a line break', () => {
    const g = notamTextGeometry('CRANE PSN 545000N010000\n0E', null)
    expect(g.point).toEqual({ lat: expect.closeTo(54.8333, 3), lon: 10 })
  })
  it('fixture 20: coordinate far from the Q-line circle -> nothing', () => {
    const g = notamTextGeometry('CRANE PSN 593922N 0175612E', { lat: 52, lon: 4, radiusNm: 5 })
    expect(g).toEqual({ polygon: null, circle: null, point: null })
  })
  it('plausibility box reaches Svalbard', () => {
    expect(notamTextGeometry('CRANE PSN 780000N 0150000E', null).point?.lat).toBeCloseTo(78, 5)
  })
})

describe('notamTextGeometry: rings need area intent or closure', () => {
  const ringsOf = (t: string) => {
    const g = notamTextGeometry(t, null)
    return g.polygon ? (g.polygon.type === 'Polygon' ? [g.polygon.coordinates[0]!] : g.polygon.coordinates.map(p => p[0]!)) : []
  }
  it('fixture 1: bounded area, closed on its first vertex', () => {
    const r = ringsOf('AREA BOUNDED BY 593922N 0175612E - 594100N 0180000E - 593700N 0180100E - 593922N 0175612E')
    expect(r).toHaveLength(1)
    expect(r[0]).toHaveLength(4)
  })
  it('fixture 5: an obstacle list is not a polygon', () => {
    const g = notamTextGeometry('OBST 551234N 0141234E, 551300N 0141300E, 551400N 0141400E ERECTED', null)
    expect(g.polygon).toBeNull()
  })
  it('fixture 14: two rings joined only by dashes', () => {
    const r = ringsOf('5712N 01200E - 5718N 01215E - 5705N 01220E - 5712N 01200E - 5800N 01300E - 5810N 01310E - 5805N 01320E - 5800N 01300E')
    expect(r.map(x => x.length)).toEqual([4, 4])
  })
  it('fixture 15: open run after WITHIN is a ring, without area word it is not', () => {
    const c = '571200N 0120030E - 571800N 0121500E - 570500N 0122000E'
    expect(ringsOf(`WITHIN ${c}`)).toHaveLength(1)
    expect(ringsOf(c)).toHaveLength(0)
  })
  it('"point of origin" closes an open run', () => {
    expect(ringsOf('571200N 0120030E - 571800N 0121500E - 570500N 0122000E - TO THE POINT OF ORIGIN')).toHaveLength(1)
  })
})

describe('notamTextGeometry: excluding circles', () => {
  const t = '5 NM RADIUS OF 593900N 0175600E, EXCLUDING 1 NM RADIUS OF 594000N 0175700E'
  it('fixture 4: one circle, the exclusion is not a second area', () => {
    const g = notamTextGeometry(t, null)
    expect(g.polygon).toBeNull()
    expect(g.circle).toEqual({ lat: expect.closeTo(59.65, 4), lon: expect.closeTo(17.9333, 3), radiusNm: 5 })
    expect(g.excluded).toHaveLength(1)
    expect(g.excluded![0]!.radiusNm).toBe(1)
  })
  it('EXCEPT / NOT INCLUDING work too, and the area note names the cut-out', () => {
    for (const w of ['EXCEPT', 'NOT INCLUDING']) {
      expect(notamTextGeometry(t.replace('EXCLUDING', w), null).circle?.radiusNm).toBe(5)
    }
    expect(notamAreaQualifier(t)).toBe('Excluding 1 NM radius around 594000N0175700E')
  })
  it('two plain circles are still two areas', () => {
    expect(notamTextGeometry('1 NM RADIUS OF 593900N 0175600E AND 2 NM RADIUS OF 594000N 0175700E', null).polygon?.type).toBe('MultiPolygon')
  })
})

describe('notamTextGeometry: arcs', () => {
  const arcText = (radius: string, word = 'CLOCKWISE ARC RADIUS') =>
    `570500N 0120000E - ${word} ${radius} CENTRED ON 570000N 0120000E TO 570000N 0120911E - 565500N 0120911E - 565500N 0120000E - 570500N 0120000E`
  const ring = (t: string, q: { lat: number; lon: number; radiusNm: number } | null = null) => {
    const g = notamTextGeometry(t, q)
    return g.polygon?.type === 'Polygon' ? g.polygon.coordinates[0]! : null
  }
  it('fixture 11: clockwise quarter arc without ALONG, radius before the centre', () => {
    const r = ring(arcText('5 NM'))!
    expect(r.length).toBeGreaterThan(10)
    expect(r[0]).toEqual(r[r.length - 1])
    // arc bulges NE of the chord: some point is ~5 NM from the centre, none is the centre
    const d = (p: number[]) => Math.hypot((p[1]! - 57), (p[0]! - 12) * Math.cos(57 * Math.PI / 180)) * 60
    expect(r.slice(1, 9).every(p => Math.abs(d(p) - 5) < 0.2)).toBe(true)
  })
  it('fixture 12: stated 8 NM but real 5 NM -> no polygon, Q-line circle stays, no circle at the centre', () => {
    const g = notamTextGeometry(arcText('8 NM'), { lat: 57.0, lon: 12.1, radiusNm: 8 })
    expect(g).toEqual({ polygon: null, circle: null, point: null })
  })
  it('anti-clockwise, radius after the centre, "OF A CIRCLE"', () => {
    const t = '570500N 0120000E - ANTICLOCKWISE ARC OF A CIRCLE CENTRED ON 570000N 0120000E RADIUS 5 NM TO 570000N 0115049E - 565500N 0115049E - 565500N 0120000E - 570500N 0120000E'
    expect(ring(t)!.length).toBeGreaterThan(10)
    expect(ring(t.replace('RADIUS 5 NM', 'RADIUS 9 NM'))).toBeNull()
  })
  it('arc without a stated radius is accepted', () => {
    expect(ring(arcText('').replace('RADIUS  ', ''))).not.toBeNull()
  })
})

describe('notamTextGeometry: written-out units', () => {
  const radius = (t: string) => notamTextGeometry(t, null).circle?.radiusNm
  it('fixture 2: metres', () => {
    const g = notamTextGeometry('RADIUS 500 METRES CENTRED ON 593900N 0175600E', null)
    expect(g.circle?.lat).toBeCloseTo(59.65, 5)
    expect(g.circle?.lon).toBeCloseTo(17.933333, 5)
    expect(g.circle?.radiusNm).toBeCloseTo(0.27, 3)
  })
  it('fixture 3: nautical miles', () => {
    expect(radius('WITHIN 3 NAUTICAL MILES RADIUS OF 593900N 0175600E')).toBe(3)
    expect(radius('RADIUS 1 NAUTICAL MILE CENTRED ON 593900N 0175600E')).toBe(1)
  })
  it('kilometres, meters, statute miles', () => {
    expect(radius('2 KILOMETRES RADIUS OF 593900N 0175600E')).toBeCloseTo(1.08, 2)
    expect(radius('RADIUS 500 METERS AROUND 593900N 0175600E')).toBeCloseTo(0.27, 3)
    expect(radius('2 STATUTE MILES RADIUS OF 593900N 0175600E')).toBeCloseTo(1.74, 2)
    expect(radius('3 SM RADIUS OF 593900N 0175600E')).toBeCloseTo(2.61, 2)
  })
})
