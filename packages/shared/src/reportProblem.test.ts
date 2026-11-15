import { describe, expect, it } from 'vitest'
import { buildReportProblemMailto, REPORT_PROBLEM_EMAIL } from './reportProblem'

function parse(url: string) {
  const [head, query] = url.split('?')
  const p = new URLSearchParams(query)
  return { to: head.replace('mailto:', ''), subject: p.get('subject')!, body: p.get('body')! }
}

describe('buildReportProblemMailto', () => {
  it('addresses the report mailbox with the airfield in the subject', () => {
    const m = parse(buildReportProblemMailto({ icao: 'estl' }))
    expect(m.to).toBe(REPORT_PROBLEM_EMAIL)
    expect(m.subject).toBe('Airfield data: ESTL')
  })

  it('puts airfield, app and data version into the body', () => {
    const m = parse(buildReportProblemMailto({
      icao: 'ESTL', name: 'LJUNGBYHED', platform: 'android', appVersion: '0.9.0', dataGeneratedAt: '2026-11-15T11:11:12+00:00',
    }))
    expect(m.body).toContain('Aerodrome: ESTL (LJUNGBYHED)')
    expect(m.body).toContain('App: android 0.9.0')
    expect(m.body).toContain('Data: 2026-11-15')
    expect(m.body).toContain('What is wrong or missing:')
  })

  it('says unknown when the versions are not known and encodes special characters', () => {
    const url = buildReportProblemMailto({ icao: 'ESMS', name: 'A&B #1 å' })
    expect(url).not.toMatch(/[ &]B/) // the "&" of the name must not split the query
    const m = parse(url)
    expect(m.body).toContain('Aerodrome: ESMS (A&B #1 å)')
    expect(m.body).toContain('App: unknown')
    expect(m.body).toContain('Data: unknown')
  })

  it('tells an aerodrome without an ICAO code by its name', () => {
    const m = parse(buildReportProblemMailto({ icao: '', name: 'Marsvinsholm' }))
    expect(m.subject).toBe('Airfield data: Marsvinsholm')
    expect(m.body).toContain('Aerodrome: Marsvinsholm\n')
  })

  it('does not throw for an aerodrome whose icao is null: its local id, else its name', () => {
    const noIcao = { icao: null, localId: 'ESMARS', name: 'Marsvinsholm' }
    expect(parse(buildReportProblemMailto(noIcao)).subject).toBe('Airfield data: ESMARS')
    expect(parse(buildReportProblemMailto(noIcao)).body).toContain('Aerodrome: ESMARS (Marsvinsholm)')
    expect(parse(buildReportProblemMailto({ icao: null, name: 'Marsvinsholm' })).subject).toBe('Airfield data: Marsvinsholm')
    expect(() => buildReportProblemMailto({})).not.toThrow()
  })
})
