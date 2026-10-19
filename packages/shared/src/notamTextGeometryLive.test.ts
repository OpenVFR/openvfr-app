import { describe, it, expect } from 'vitest'
import { notamTextGeometry, notamAreaQualifier } from './notamTextGeometry'
import { notamShortText } from './notamIcaoFormat'

// Live texts from AIRAC 2610 that used to fall back to the Q-line circle/point.
const CZ_GLIDERS = "NAV WRNG - MASS MOV OF GLIDERS IN AREA PSN \n500954,00N0173535,00E (0.7NM E MESTO ALBRECHTICE) - ALONG STATE BDRY\nOF CR - PSN 500350,11N0174535,49E (2.6NM E LKKR) - PSN \n494857,80N0173957,66E (1.3NM N SVATONOVICE) - PSN \n495625,43N0172544,83E (0.5NM NW VALSOV) - PSN 500632,08N0172659,00E \n(KARLOVICE) - PSN 500954,00N0173535,00E (0.7NM E MESTO ALBRECHTICE)"
const DE_MAYEN = "UAS OPERATION AREA 501645N0071309E-501942N0071052E-501847N0070024E\n-501710N070521E-501645N0071309E VICINITY OF MAYEN. CTR ETSB EXCLUDED."
const DE_NORTH_SEA = "NVG TRAINING OF MIL HELICOPTERS WITH LIGHT AMPLIFYING DEVICES\nDISPLAYING NO OR MNM LIGHTING TO AND WI FOLLOWING NORTH SEA AREA:\n550\n000N0063000E-550000N00900\n00E-533000N0090000E-53300\n0N0063000E-550000N0\n063000E ONLY WITHIN\nGERMAN TERRITORY.\nAIRSPACE CAT C/D AND ALL\nED-R\nARE EXCLUDED.\nCONTACT MIL AIM ETMN ONLY\nFOR INFO ABOUT SCHEDULED\nTRAFFIC VIA PHONE\n+49 4741 94 12722."

const ringOf = (g: ReturnType<typeof notamTextGeometry>) =>
  g.polygon?.type === 'Polygon' ? g.polygon.coordinates[0]! : []

describe('notamTextGeometry: live regressions', () => {
  it('polygon continues across "(commentary)", PSN labels and "ALONG STATE BDRY OF CR"', () => {
    const g = notamTextGeometry(CZ_GLIDERS, { lat: 50 + 9 / 60, lon: 17 + 35 / 60, radiusNm: 11 })
    expect(g.polygon?.type).toBe('Polygon')
    expect(ringOf(g)).toHaveLength(6)
  })
  it('longitude missing its leading zero keeps the vertex', () => {
    const g = notamTextGeometry(DE_MAYEN, { lat: 50.3, lon: 7.2, radiusNm: 5 })
    const ring = ringOf(g)
    expect(ring).toHaveLength(5)
    expect(ring[3]![0]).toBeCloseTo(7 + 5 / 60 + 21 / 3600, 5)
  })
  it('longitude hemisphere typed as N is read as E', () => {
    const g = notamTextGeometry('GAS RELEASE PSN 520715.38N 0205330.39N SEKOCIN NOWY', { lat: 52.1, lon: 20.9, radiusNm: 1 })
    expect(g.point?.lon).toBeCloseTo(20 + 53 / 60 + 30.39 / 3600, 4)
  })
  it('"<r>NM CENTERED ON <c>" without the word RADIUS is a circle', () => {
    const g = notamTextGeometry('HIGH ALT GLD WINCH LAUNCHES 2NM CENTERED ON 481400N 0113400E, OBERSCHLEISSHEIM.', { lat: 48.23, lon: 11.57, radiusNm: 2 })
    expect(g.circle).toEqual({ lat: 48 + 14 / 60, lon: 11 + 34 / 60, radiusNm: 2 })
  })
  it('North Sea NVG polygon still parses', () => {
    const g = notamTextGeometry(DE_NORTH_SEA, { lat: 54.25, lon: 7.75, radiusNm: 63 })
    expect(ringOf(g)).toHaveLength(5)
  })
})

describe('notamAreaQualifier', () => {
  it('reports the territory limit and exclusions, not the schedule or contact lines', () => {
    expect(notamAreaQualifier(DE_NORTH_SEA)).toBe('Only within german territory. Airspace cat c/d and all ed-r are excluded')
  })
  it('keeps a short exclusion', () => {
    expect(notamAreaQualifier(DE_MAYEN)).toBe('Ctr etsb excluded')
  })
  it('null when nothing narrows the area', () => {
    expect(notamAreaQualifier('UAS OPERATION 1NM RADIUS CENTERED ON 485007N 0133359E FREYUNG')).toBeNull()
    expect(notamAreaQualifier('MON-THU, EXCEPT GERMAN HOLIDAYS NVG TRAINING')).toBeNull()
  })
})

describe('short view', () => {
  it('keeps the area limit that the first sentence drops', () => {
    const s = notamShortText({ id: 'M3010/26', text: DE_NORTH_SEA, effective: null, expires: null, qCode: 'QWELW' })
    expect(s).toContain('[Only within german territory.')
  })
  it('Faroe obstacle (western longitude) is a point', () => {
    const g = notamTextGeometry('OBST LIGHTS SUDUROY 2 612351N0064058W U/S', { lat: 61 + 24 / 60, lon: -(6 + 41 / 60), radiusNm: 1 })
    expect(g.point?.lon).toBeCloseTo(-6.6828, 3)
  })
})
