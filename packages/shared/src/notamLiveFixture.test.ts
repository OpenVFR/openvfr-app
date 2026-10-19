/**
 * Golden test over real NOTAMs (NMS-API, AIRAC 2610, trimmed to ~24 records
 * + 60 item-D schedules in fixtures/liveNotams.json). Each record was
 * checked by hand against its text; the point is to notice when a parser
 * change moves any of them. When a change is intended, re-check the text
 * and update the expectation.
 */
import { describe, it, expect } from 'vitest'
import fx from './fixtures/liveNotams.json'
import { notamTextGeometry } from './notamTextGeometry'
import { parseNotamSchedule } from './notamSchedule'

const qpos = (d: string | null) => {
  const m = d && /^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])$/.exec(d)
  return m ? { lat: (+m[1]! + +m[2]! / 60) * (m[3] === 'S' ? -1 : 1), lon: (+m[4]! + +m[5]! / 60) * (m[6] === 'W' ? -1 : 1) } : null
}

function shape(n: (typeof fx.notams)[number]): string {
  const g = qpos(n.qCoordinates ?? null)
  const r = Number(n.qRadius)
  const t = notamTextGeometry(n.text, g ? { ...g, radiusNm: Number.isFinite(r) ? r : null } : null)
  if (t.polygon) return t.polygon.type === 'Polygon'
    ? `polygon:${t.polygon.coordinates[0]!.length}`
    : `multi:${t.polygon.coordinates.map(p => p[0]!.length).join('+')}`
  if (t.circle) return `circle:${t.circle.radiusNm}`
  return t.point ? 'point' : 'none'
}

// Ring sizes count the closing vertex.
const EXPECTED_SHAPE: Record<string, string> = {
  'M2821/26': 'circle:1.5',   // UAS 1.5NM RADIUS CENTERED ON
  'M3838/26': 'circle:1.5',   // PSN c RADIUS 1.5NM
  'M4354/26': 'circle:2',     // AREA: PSN c RADIUS 2NM
  'M2890/26': 'circle:0.15',  // RADIUS 0.15NM AROUND PSN
  'M3185/26': 'circle:1.5',
  'D3442/26': 'circle:2',     // 2NM CENTERED ON (no word RADIUS)
  'H5253/26': 'circle:3',
  'M3010/26': 'polygon:5',    // North Sea box, "ONLY WITHIN GERMAN TERRITORY"
  'M3011/26': 'polygon:11',   // Baltic area
  'M3338/26': 'polygon:5',    // longitude typo "070521E" keeps its vertex
  'B3442/26': 'polygon:6',    // "(commentary)", PSN labels, "ALONG STATE BDRY OF CR"
  'B0451/26': 'polygon:5',
  'D0524/26': 'polygon:5',
  'B6004/26': 'polygon:5',
  'C3521/26': 'polygon:33',
  'X8933/26': 'multi:11+10',
  'D7011/26': 'multi:7+13+13',
  'D5173/26': 'multi:3+3',    // KNOWN LIMITATION: banner-towing ROUTES (A -> coast -> B), drawn as degenerate polygons
  'F2450/26': 'point',
  'D7523/26': 'point',        // "0205330.39N" (N for E) is read as E
  'E0075/26': 'point',        // western longitude
  'A5829/26': 'none',         // designator only (EFR143A) -- needs charted airspace
  'A1090/26': 'none',         // trigger NOTAM naming ESD317-319
  'B1862/26': 'none',         // ATS hours list
}

describe('live NOTAM fixture', () => {
  it('has every expectation', () => {
    expect(fx.notams.map(n => n.id).sort()).toEqual(Object.keys(EXPECTED_SHAPE).sort())
  })
  for (const n of fx.notams) {
    it(`${n.id}: ${EXPECTED_SHAPE[n.id]}`, () => {
      expect(shape(n)).toBe(EXPECTED_SHAPE[n.id])
    })
  }
  it('item D schedules: all live samples parse', () => {
    const bad = fx.schedules.filter(s => !parseNotamSchedule({ itemD: s, effective: '2026-10-01T00:00:00Z' }))
    expect(bad).toEqual([])
  })
  it('the German NVG NOTAMs get their schedule from the E) text', () => {
    for (const id of ['M3010/26', 'M3011/26']) {
      const n = fx.notams.find(x => x.id === id)!
      expect(parseNotamSchedule({ itemD: n.schedule, text: n.text, effective: n.effective })).not.toBeNull()
    }
  })
})
