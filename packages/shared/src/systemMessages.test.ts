import { describe, expect, it } from 'vitest'
import {
  activeSystemMessages, compareAppVersions, isDismissible, parseSystemMessages, pruneDismissed,
  SYSTEM_MESSAGE_LIMITS,
} from './systemMessages'

const T = (iso: string) => Date.parse(iso)

const doc = (messages: unknown[]) => ({ version: 1, messages })

describe('parseSystemMessages', () => {
  it('parses a valid document', () => {
    const [m] = parseSystemMessages(doc([{
      id: 'm1', severity: 'warning', title: 'Planned maintenance', body: 'Sync unavailable',
      startsAt: '2026-11-15T06:00:00Z', endsAt: '2026-11-15T07:00:00Z',
      platforms: ['web', 'ios'], minAppVersion: '1.2', url: 'https://example.org/status', extra: 1,
    }]))
    expect(m).toEqual({
      id: 'm1', severity: 'warning', title: 'Planned maintenance', body: 'Sync unavailable',
      startsAt: T('2026-11-15T06:00:00Z'), endsAt: T('2026-11-15T07:00:00Z'),
      platforms: ['web', 'ios'], minAppVersion: '1.2', url: 'https://example.org/status',
    })
  })

  it('returns [] for anything that is not a version-1 document', () => {
    for (const bad of [null, 'x', 42, {}, { version: 2, messages: [] }, { version: 1, messages: 'no' }]) {
      expect(parseSystemMessages(bad)).toEqual([])
    }
  })

  it('drops invalid messages and duplicates, keeps the rest', () => {
    const out = parseSystemMessages(doc([
      { id: 'a', severity: 'info', title: 'ok' },
      { id: 'a', severity: 'info', title: 'duplicate' },
      { id: 'b', severity: 'panic', title: 'bad severity' },
      { id: '', severity: 'info', title: 'no id' },
      { id: 'c', severity: 'info' },
      { id: 'd', severity: 'info', title: 'unknown platforms only', platforms: ['windows'] },
      'nope',
    ]))
    expect(out.map(m => m.id)).toEqual(['a'])
  })

  it('caps text, strips control characters, ignores non-https urls and bad dates/versions', () => {
    const [m] = parseSystemMessages(doc([{
      id: 'x', severity: 'info', title: 'T'.repeat(500), body: 'line1\nline2\u0007',
      url: 'javascript:alert(1)', startsAt: 'not a date', minAppVersion: 'v1',
    }]))
    expect(m!.title.length).toBe(SYSTEM_MESSAGE_LIMITS.title)
    expect(m!.body).toBe('line1\nline2')
    expect(m!.url).toBeUndefined()
    expect(m!.startsAt).toBeUndefined()
    expect(m!.minAppVersion).toBeUndefined()
  })

  it('limits the number of messages', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, severity: 'info', title: 't' }))
    expect(parseSystemMessages(doc(many))).toHaveLength(SYSTEM_MESSAGE_LIMITS.messages)
  })
})

describe('activeSystemMessages', () => {
  const msgs = parseSystemMessages(doc([
    { id: 'info', severity: 'info', title: 'i' },
    { id: 'crit', severity: 'critical', title: 'c' },
    { id: 'future', severity: 'warning', title: 'f', startsAt: '2026-12-01T00:00:00Z' },
    { id: 'past', severity: 'warning', title: 'p', endsAt: '2026-10-01T00:00:00Z' },
    { id: 'ios', severity: 'warning', title: 'ios only', platforms: ['ios'] },
    { id: 'old', severity: 'warning', title: 'old apps', maxAppVersion: '1.0.9' },
  ]))
  const now = T('2026-11-01T00:00:00Z')

  it('filters by time window and platform, sorts by severity', () => {
    expect(activeSystemMessages(msgs, { now, platform: 'web' }).map(m => m.id)).toEqual(['crit', 'old', 'info'])
    expect(activeSystemMessages(msgs, { now, platform: 'ios' }).map(m => m.id)).toEqual(['crit', 'ios', 'old', 'info'])
  })

  it('applies version limits only when the version is known', () => {
    expect(activeSystemMessages(msgs, { now, platform: 'android', appVersion: '1.1.0' }).map(m => m.id)).toEqual(['crit', 'info'])
    expect(activeSystemMessages(msgs, { now, platform: 'android', appVersion: '1.0.2' }).map(m => m.id)).toEqual(['crit', 'old', 'info'])
  })

  it('hides dismissed messages except critical ones', () => {
    expect(activeSystemMessages(msgs, { now, platform: 'web', dismissed: ['info', 'crit', 'old'] }).map(m => m.id)).toEqual(['crit'])
    expect(isDismissible(msgs.find(m => m.id === 'crit')!)).toBe(false)
  })
})

describe('helpers', () => {
  it('compares versions', () => {
    expect(compareAppVersions('1.2', '1.2.0')).toBe(0)
    expect(compareAppVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareAppVersions('0.9', '1')).toBe(-1)
  })
  it('prunes dismissed ids no longer in the document', () => {
    const msgs = parseSystemMessages(doc([{ id: 'a', severity: 'info', title: 't' }]))
    expect(pruneDismissed(['a', 'gone'], msgs)).toEqual(['a'])
  })
})
