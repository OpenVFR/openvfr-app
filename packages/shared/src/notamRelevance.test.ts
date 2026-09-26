import { describe, it, expect } from 'vitest'
import { relevantFirPrefixes, applyNotamRelevance, relevanceHiddenNote, isIfrOnly } from './notamRelevance'

const stockholm = { lat: 59.35, lng: 17.94 }

const n = (o: Partial<{ lat: number | null; lon: number | null; affectedFir: string | null; traffic: string | null }>) => ({
  lat: o.lat === undefined ? null : o.lat,
  lon: o.lon === undefined ? null : o.lon,
  affectedFir: o.affectedFir ?? null,
  icao: o.traffic === undefined ? null : { traffic: o.traffic },
})

describe('relevantFirPrefixes', () => {
  it('Stockholm is in Sweden (and not Lithuania)', () => {
    const s = relevantFirPrefixes([stockholm])
    expect(s.has('ES')).toBe(true)
    expect(s.has('EY')).toBe(false)
  })
  it('extra ICAOs add their prefix', () => {
    expect(relevantFirPrefixes([], ['EKCH', 'bad']).has('EK')).toBe(true)
  })
})

describe('applyNotamRelevance', () => {
  const fir = relevantFirPrefixes([stockholm])
  it('hides positionless NOTAMs of other FIRs, keeps own and positioned ones', () => {
    const list = [
      n({ affectedFir: 'EYVL' }),                    // Lithuanian whole-FIR -> hidden
      n({ affectedFir: 'ESAA' }),                    // Swedish whole-FIR -> kept
      n({ affectedFir: 'EYVL', lat: 55, lon: 24 }),  // positioned -> distance filter's job, kept here
      n({}),                                         // unknown FIR -> kept
    ]
    const r = applyNotamRelevance(list, { vfrOnly: false, firPrefixes: fir })
    expect(r.kept.length).toBe(3)
    expect(r.hiddenOtherFir).toBe(1)
  })
  it('VFR only hides IFR-only, keeps IV and unknown', () => {
    const list = [n({ traffic: 'I' }), n({ traffic: 'IV' }), n({ traffic: 'V' }), n({})]
    const r = applyNotamRelevance(list, { vfrOnly: true, firPrefixes: new Set() })
    expect(r.kept.length).toBe(3)
    expect(r.hiddenIfrOnly).toBe(1)
    expect(applyNotamRelevance(list, { vfrOnly: false, firPrefixes: new Set() }).kept.length).toBe(4)
  })
  it('empty prefix set disables FIR scoping (nothing to judge against)', () => {
    expect(applyNotamRelevance([n({ affectedFir: 'EYVL' })], { vfrOnly: false, firPrefixes: new Set() }).kept.length).toBe(1)
  })
  it('isIfrOnly', () => {
    expect(isIfrOnly(n({ traffic: 'I' }))).toBe(true)
    expect(isIfrOnly(n({ traffic: 'K' }))).toBe(true)
    expect(isIfrOnly(n({}))).toBe(false)
  })
})

describe('relevanceHiddenNote', () => {
  it('formats', () => {
    expect(relevanceHiddenNote({ hiddenIfrOnly: 2, hiddenOtherFir: 1 })).toBe('3 NOTAMs hidden (2 IFR-only, 1 for other FIRs)')
    expect(relevanceHiddenNote({ hiddenIfrOnly: 0, hiddenOtherFir: 0 })).toBeNull()
  })
})

describe('applyNotamRelevance duplicates', () => {
  it('shows an identical notice once, keeps same number with different text', () => {
    const a = { id: 'U0040/26', text: 'GEMIL FLIP MAP', lat: null, lon: null }
    const r = applyNotamRelevance([a, { ...a }, { ...a, text: 'OTHER' }], { vfrOnly: false, firPrefixes: new Set() })
    expect(r.kept.length).toBe(2)
    expect(r.hiddenOtherFir + r.hiddenIfrOnly).toBe(0)
  })
})
