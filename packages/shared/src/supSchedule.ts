/**
 * supSchedule -- "in its scheduled hours now / outside them" for areas that an AIP supplement established.
 * The pipeline marks such areas `source: "sup"` and keeps the supplement's own schedule text in `schedule`
 * (UTC first, local time in brackets), for example:
 *   "01 SEP 2026 - 31 JAN 2027, MON - FRI 0700 - 1700 (0600 - 1600)"
 *   "01 JAN 2026 - 31 DEC 2026\nMON-THU 0600 - 1900 (0500 - 1800)\nFRI 0600 - 1300 (0500 - 1200)"
 *
 * Only the regular weekday / daily forms are read (through parseNotamSchedule). Anything else -- date-only,
 * H24, absolute date spans, several different date ranges -- gives null: no statement is better than a
 * wrong one. The result is information for the pilot only; it never hides an area or silences a warning.
 */
import { fmtUtcDayClock } from './notamValidity'
import { nextScheduleChange, parseNotamSchedule, scheduleOverlaps } from './notamSchedule'

const SUP_LOOKAHEAD_MS = 4 * 86_400_000

/** Sweden's middle: only used where a schedule needs a position (sun times), which these forms do not. */
const POS = { lat: 62, lon: 15 }
const DATE = String.raw`\d{1,2}\b(?:\s+[A-Z]{3}(?:\s+20\d{2})?)?`
const DATE_PREFIX = new RegExp(String.raw`^\s*${DATE}(?:\s*-\s*${DATE})?\s*,?\s*`)
const DAY_WORD = /^(?:MON|TUE|WED|THU|FRI|SAT|SUN|DAILY)\b/

/** The weekday/time part of a supplement schedule in item-D form, or null when it is not a regular one. */
export function supScheduleItemD(schedule: string): string | null {
  const text = schedule
    .toUpperCase()
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bDAGLIGEN\s*\/\s*/g, '')
  const parts: string[] = []
  let range: string | null = null   // the one date range every line must share
  let undatedFirst = false          // a weekday line came before any date range
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim()
    if (!line) continue
    const m = DATE_PREFIX.exec(line)
    const rest = (m ? line.slice(m[0].length) : line).replace(/\s+/g, ' ').trim()
    const pre = m ? m[0].replace(/[\s,]+/g, ' ').trim() : ''
    if (pre) {
      if (range !== null && pre !== range) return null   // several different date ranges
      if (undatedFirst) return null                       // that earlier line would lose the limit
      range = pre
    }
    if (!rest) continue                                   // a line with only a date range applies to the lines after it
    if (!DAY_WORD.test(rest)) return null
    if (range === null) undatedFirst = true
    parts.push(rest)
  }
  return parts.length > 0 ? parts.join(', ') : null
}

/** One line for the area's card, e.g. "Now: outside its scheduled hours (next Wed 07:00Z)", or null. */
export function supScheduleLine(props: unknown, nowMs: number = Date.now()): string | null {
  const p = props as { source?: unknown; schedule?: unknown; active_from?: unknown; active_until?: unknown } | null | undefined
  if (!p || p.source !== 'sup' || typeof p.schedule !== 'string') return null
  const from = typeof p.active_from === 'string' ? Date.parse(p.active_from) : NaN
  const until = typeof p.active_until === 'string' ? Date.parse(p.active_until) : NaN
  // Before the supplement starts or after it ended the schedule says nothing about "now".
  if ((Number.isFinite(from) && nowMs < from) || (Number.isFinite(until) && nowMs > until)) return null
  const itemD = supScheduleItemD(p.schedule)
  if (!itemD) return null
  const s = parseNotamSchedule({ itemD, effective: Number.isFinite(from) ? new Date(from).toISOString() : null })
  if (!s) return null
  const within = (t: number) => (Number.isFinite(until) ? t < until : true)
  if (scheduleOverlaps(s, nowMs, nowMs + 60_000, POS)) {
    const off = nextScheduleChange(s, POS, nowMs, SUP_LOOKAHEAD_MS, false)
    return `Now: in its scheduled hours${off !== null && within(off) ? ` (until ${fmtUtcDayClock(off, nowMs)})` : ''}`
  }
  const on = nextScheduleChange(s, POS, nowMs, SUP_LOOKAHEAD_MS, true)
  return `Now: outside its scheduled hours${on !== null && within(on) ? ` (next from ${fmtUtcDayClock(on, nowMs)})` : ''}`
}

/**
 * One status line for the area's card, led by the validity of the supplement: "Not yet in force: starts 14 Nov
 * 11:00Z, until 19 Nov 11:00Z" / "In force until 19 Nov 11:00Z" / "Ended 10 Nov 23:59Z". Null for an area that is
 * not from a supplement or has no usable dates. The schedule line below it says what the hours are.
 */
export function supValidityLine(props: unknown, nowMs: number = Date.now()): string | null {
  const p = props as { source?: unknown; active_from?: unknown; active_until?: unknown } | null | undefined
  if (!p || p.source !== 'sup') return null
  const from = typeof p.active_from === 'string' ? Date.parse(p.active_from) : NaN
  const until = typeof p.active_until === 'string' ? Date.parse(p.active_until) : NaN
  if (Number.isFinite(from) && nowMs < from) {
    return `Not yet in force: starts ${fmtUtcDayClock(from, nowMs)}${Number.isFinite(until) ? `, until ${fmtUtcDayClock(until, nowMs)}` : ''}`
  }
  if (Number.isFinite(until)) return nowMs > until ? `Ended ${fmtUtcDayClock(until, nowMs)}` : `In force until ${fmtUtcDayClock(until, nowMs)}`
  return null
}
