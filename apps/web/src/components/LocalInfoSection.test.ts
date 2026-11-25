import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LocalInfo } from '@open-vfr/shared/aerodromeDetails'

const base: LocalInfo = {
  circuits: [], runwayEnds: [], localRules: [], localRuleGroups: null, hoursRemarks: [], areas: [], reportingPoints: [], holdings: [], provenance: {},
}
let info: LocalInfo = base
vi.mock('../utils/aerodromeDetails', () => ({ useLocalInfo: () => info, useCircuitNotes: () => [] }))

import LocalInfoSection from './LocalInfoSection'
const html = () => renderToStaticMarkup(createElement(LocalInfoSection, { icao: 'ESXX', sectionClass: 's', titleClass: 't' }))

const rules = (n: number) => Array.from({ length: n }, (_, i) => `Rule number ${i}`)

describe('Local rules expander', () => {
  it('starts closed with a count and shows only the key lines of the groups', () => {
    info = { ...base, localRules: rules(6), localRuleGroups: [
      { id: 'circuit', title: 'Arrival and circuit', lines: [{ text: 'Key rule A', key: true }, { text: 'Minor rule B', key: false }] },
      { id: 'other', title: 'Other', lines: [{ text: 'Minor rule C', key: false }] },
    ] }
    const h = html()
    expect(h).toContain('aria-expanded="false"')
    expect(h).toContain('>6<')
    expect(h).toContain('Key rule A')
    expect(h).toContain('Arrival and circuit')
    expect(h).not.toContain('Minor rule B')
    expect(h).not.toContain('Other')          // a group with no key line has no heading in the preview
  })
  it('shows nothing but the heading and count while closed when there are no groups', () => {
    info = { ...base, localRules: rules(5) }
    const h = html()
    expect(h).toContain('aria-expanded="false"')
    expect(h).not.toContain('Rule number 0')
  })
  it('is open to start with when it has three lines or fewer', () => {
    info = { ...base, localRules: rules(3) }
    const h = html()
    expect(h).toContain('aria-expanded="true"')
    expect(h).toContain('Rule number 2')
  })
})
