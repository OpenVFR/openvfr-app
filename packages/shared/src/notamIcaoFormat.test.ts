import { describe, it, expect } from 'vitest'
import { notamRawText, notamFullText, notamShortText, icaoDateTime, notamText } from './notamIcaoFormat'
import type { NotamIcaoFields } from './fetchNotam'

const icao: NotamIcaoFields = {
  type: 'N', issued: '2026-08-19T08:30:00.000Z', traffic: 'IV', purpose: 'BO', scope: 'A',
  lowerFl: '000', upperFl: '999', coordinates: '5555N01405E', radius: '5', location: 'ESMK',
  schedule: null, lowerLimit: null, upperLimit: null, estimated: false,
}
// Shape taken from a real cached upstream record (ESMK tower hours).
const n = {
  id: 'B2671/26',
  text: 'AERODROME CONTROL TOWER (TWR) HOURS OF SERVICE ARE NOW MON-THU\n0515-1730, FRI 0515-1400, SAT-SUN CLSD.',
  effective: '2026-09-07T00:00:00.000Z',
  expires: '2026-09-27T23:59:00.000Z',
  qCode: 'QSTAH',
  affectedFir: 'ESAA',
  icao,
}

describe('notamRawText', () => {
  it('rebuilds the ICAO item layout', () => {
    expect(notamRawText(n)).toBe(
      'B2671/26 NOTAMN\n' +
      'Q) ESAA/QSTAH/IV/BO/A/000/999/5555N01405E005\n' +
      'A) ESMK B) 2609070000 C) 2609272359\n' +
      'E) AERODROME CONTROL TOWER (TWR) HOURS OF SERVICE ARE NOW MON-THU\n0515-1730, FRI 0515-1400, SAT-SUN CLSD.',
    )
  })
  it('includes D/F/G and EST when present', () => {
    const r = notamRawText({ ...n, icao: { ...icao, schedule: 'MON-FRI 0700-1500', lowerLimit: 'SFC', upperLimit: '2000FT AMSL', estimated: true } })
    expect(r).toContain('C) 2609272359 EST')
    expect(r).toContain('D) MON-FRI 0700-1500')
    expect(r).toContain('F) SFC G) 2000FT AMSL')
  })
  it('PERM end', () => {
    expect(notamRawText({ ...n, expires: '9999-12-31T23:59:00.000Z' })).toContain('C) PERM')
  })
  it('falls back to plain text without structured fields', () => {
    expect(notamRawText({ ...n, icao: null })).toBe(n.text)
  })
})

describe('notamFullText / notamShortText', () => {
  it('full has validity + text', () => {
    const f = notamFullText({ ...n, icao: { ...icao, schedule: 'H24' } })
    expect(f.split('\n')[0]).toBe('Valid 07 Sep 00:00Z – 27 Sep 23:59Z')
    expect(f).toContain('Schedule: H24')
    expect(f).toContain('SAT-SUN CLSD.')
  })
  it('short = decoded title + first sentence', () => {
    expect(notamShortText({ ...n, text: 'RWY 12/30 CLSD. DUE TO WIP.' , qCode: 'QMRLC' }))
      .toBe('Runway closed · B2671/26 — RWY 12/30 CLSD.')
  })
  it('short without known Q-code', () => {
    expect(notamShortText({ ...n, qCode: null, text: 'SOMETHING HAPPENS. MORE.' })).toBe('B2671/26 · SOMETHING HAPPENS.')
  })
  it('notamText dispatch', () => {
    expect(notamText(n, 'raw')).toContain('Q) ESAA/')
  })
})

describe('icaoDateTime', () => {
  it('formats UTC YYMMDDHHMM', () => expect(icaoDateTime('2026-01-02T03:04:00Z')).toBe('2601020304'))
  it('invalid', () => expect(icaoDateTime('x')).toBeNull())
})
