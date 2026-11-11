import { describe, it, expect } from 'vitest'
import { canHideNotam, hide, markRead, parseTriage, splitHidden, triageKey, unhide, EMPTY_TRIAGE, TRIAGE_MAX } from './notamTriage'

const n = (nmsId: string, over: Record<string, unknown> = {}) =>
  ({ nmsId, effective: '2026-11-01T00:00:00Z', qCode: 'QOBCE', text: 'CRANE', ...over })

describe('notamTriage', () => {
  it('hide and unhide by id + effective date', () => {
    const t = hide(EMPTY_TRIAGE, triageKey(n('a')))
    expect(splitHidden([n('a'), n('b')], t).hidden.map((x) => x.nmsId)).toEqual(['a'])
    // a re-issue with a new effective date is shown again
    expect(splitHidden([n('a', { effective: '2026-11-05T00:00:00Z' })], t).shown).toHaveLength(1)
    expect(splitHidden([n('a')], unhide(t, triageKey(n('a')))).hidden).toHaveLength(0)
  })
  it('never hides closures, warnings or restrictions', () => {
    expect(canHideNotam({ qCode: 'QFALC', text: 'AD CLSD' })).toBe(false)
    expect(canHideNotam({ qCode: 'QRTCA', text: 'TRA' })).toBe(false)
    expect(canHideNotam({ qCode: 'QWMLW', text: 'MIL EXERCISE' })).toBe(false)
    expect(canHideNotam({ qCode: 'QMRLC', text: 'RWY CLSD' })).toBe(true)
    const t = hide(EMPTY_TRIAGE, triageKey(n('c')))
    expect(splitHidden([n('c', { qCode: 'QFALC', text: 'AD CLSD' })], t).shown).toHaveLength(1)
  })
  it('read marks are unique and capped', () => {
    let t = markRead(EMPTY_TRIAGE, 'k')
    t = markRead(t, 'k')
    expect(t.read).toEqual(['k'])
    for (let i = 0; i < TRIAGE_MAX + 20; i++) t = hide(t, `h${i}`)
    expect(t.hidden).toHaveLength(TRIAGE_MAX)
    expect(t.hidden.at(-1)).toBe(`h${TRIAGE_MAX + 19}`)
  })
  it('parses defensively', () => {
    expect(parseTriage('not json')).toEqual(EMPTY_TRIAGE)
    expect(parseTriage({ read: ['a', 5], hidden: 'x' })).toEqual({ read: ['a'], hidden: [] })
    expect(parseTriage(JSON.stringify({ read: [], hidden: ['q'] }))).toEqual({ read: [], hidden: ['q'] })
  })
})
