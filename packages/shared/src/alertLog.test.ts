import { describe, it, expect } from 'vitest'
import { recordAlerts, pastAlerts, alertLogTime, markDeparted, type AlertLogEntry, type LoggableAlert } from './alertLog'

const a = (key: string, title = key): LoggableAlert => ({ key, severity: 'yellow', badge: 'B', title })

describe('recordAlerts', () => {
  it('logs an item when it first shows', () => {
    const r = recordAlerts([], [a('x')], new Set(), 1000)
    expect(r.added).toBe(true)
    expect(r.log).toMatchObject([{ key: 'x', at: 1000, lastAt: 1000 }])
  })
  it('only refreshes an item that stays on screen', () => {
    let log: AlertLogEntry[] = recordAlerts([], [a('x', 'old')], new Set(), 0).log
    const r = recordAlerts(log, [a('x', 'new')], new Set(['x']), 5000)
    expect(r.added).toBe(false)
    expect(r.log).toHaveLength(1)
    expect(r.log[0]).toMatchObject({ title: 'new', at: 0, lastAt: 5000 })
  })
  it('merges a flapping item, logs a later recurrence separately', () => {
    let log = recordAlerts([], [a('x')], new Set(), 0).log
    log = recordAlerts(log, [a('x')], new Set(), 20_000).log
    expect(log).toHaveLength(1)
    const r = recordAlerts(log, [a('x')], new Set(), 5 * 60_000)
    expect(r.added).toBe(true)
    expect(r.log).toHaveLength(2)
  })
  it('drops entries older than 30 minutes', () => {
    const log = recordAlerts([], [a('x')], new Set(), 0).log
    expect(recordAlerts(log, [], new Set(), 31 * 60_000).log).toEqual([])
  })
})

describe('pastAlerts', () => {
  it('lists what is not on screen, newest first', () => {
    let log = recordAlerts([], [a('x')], new Set(), 0).log
    log = recordAlerts(log, [a('y')], new Set(), 10_000).log
    log = recordAlerts(log, [a('z')], new Set(), 20_000).log
    expect(pastAlerts(log, new Set(['y'])).map(e => e.key)).toEqual(['z', 'x'])
  })
})

describe('alertLogTime', () => {
  it('formats UTC', () => expect(alertLogTime(Date.UTC(2026, 9, 25, 7, 5))).toBe('07:05Z'))
})

describe('markDeparted', () => {
  it('stamps the time a shown item went away', () => {
    const log = recordAlerts([], [a('x'), a('y')], new Set(), 0).log
    const next = markDeparted(log, new Set(['x', 'y']), new Set(['y']), 9000)
    expect(next.find(e => e.key === 'x')?.lastAt).toBe(9000)
    expect(next.find(e => e.key === 'y')?.lastAt).toBe(0)
  })
  it('returns the same log when nothing left', () => {
    const log = recordAlerts([], [a('x')], new Set(), 0).log
    expect(markDeparted(log, new Set(['x']), new Set(['x']), 5)).toBe(log)
  })
})
