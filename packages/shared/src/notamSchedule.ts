/**
 * notamSchedule -- when, within its B)-C) validity, a NOTAM is actually in
 * force. Many area NOTAMs (NVG training, UAS, exercises, TRAs) are active
 * only at certain times: "MON-THU 0700-1630, FRI 0700-1200", "DAILY SR-SS",
 * "DAILY SS PLUS30 - 0300", "05-08 0500-1600, 09 0500-1000". The B)/C)
 * window alone says "active" for the whole period.
 *
 * Sources, in order:
 *   1. item D) -- parseNotamSchedule({ itemD })
 *   2. a schedule written at the start of item E) (some states put it there):
 *      "MON-THU, DAILY SS+30 - 23:00, EXCEPT GERMAN HOLIDAYS NVG TRAINING ..."
 *
 * Supported: DAILY/DLY/EVERY, weekdays and ranges (MON-THU), HHMM-HHMM
 * (incl. past midnight and several groups), H24, SR/SS with +-minutes
 * ("SS PLUS30", "SR-SS", "30 MINUTES AFTER SUNSET", computed for the NOTAM's
 * position), day-of-month lists and ranges ("05-08 12-15 0500-1600"), month
 * names ("OCT 01-25", "OCT 26-DEC 11"), "FRI 1500-MON 0600", and trailing
 * "EXC <weekdays | MMM DD ...>".
 *
 * Not supported (-> parseNotamSchedule returns null, the NOTAM is treated as
 * always in force, the safe default): anything else, and "EXCEPT <country>
 * HOLIDAYS" (flagged on the result but not evaluated).
 */
import { sunriseSunset } from './sunCalc'

const DAY_MS = 86_400_000
const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/** Time of day: minutes after midnight UTC, or relative to sunrise/sunset. */
type Tm = { kind: 'abs'; min: number } | { kind: 'sr' | 'ss'; offsetMin: number }

interface Entry {
  /** null = every weekday */
  days: boolean[] | null
  /** [startMs, endMs) UTC-day ranges; null = any date */
  dates: Array<[number, number]> | null
  start: Tm
  end: Tm
  /** "FRI 1500-MON 0600": weekday the end time falls on */
  endDow: number | null
  /** "20 0500-21 1400": one absolute period [startMs, endMs) (start/end above unused) */
  span?: [number, number]
}

export interface NotamSchedule {
  entries: Entry[]
  excludeDays: boolean[] | null
  excludeDates: Array<[number, number]>
  /** Text says "EXCEPT <...> HOLIDAYS": not evaluated, the NOTAM may be off on those days. */
  holidays: boolean
}

// ── normalisation ──────────────────────────────────────────────────────────

const TM = String.raw`(?:\d{4}|SR|SS)(?:[+-]\d{1,3})?`

function normalise(s: string): string {
  return s.toUpperCase()
    .replace(/\r|\n/g, ' ')
    .replace(/(\d{2}):(\d{2})/g, '$1$2')
    .replace(/(\d+)\s*MIN(?:UTE)?S?\s+AFTER\s+(?:SUNSET|SS)\b/g, 'SS+$1')
    .replace(/(\d+)\s*MIN(?:UTE)?S?\s+BEFORE\s+(?:SUNSET|SS)\b/g, 'SS-$1')
    .replace(/(\d+)\s*MIN(?:UTE)?S?\s+AFTER\s+(?:SUNRISE|SR)\b/g, 'SR+$1')
    .replace(/(\d+)\s*MIN(?:UTE)?S?\s+BEFORE\s+(?:SUNRISE|SR)\b/g, 'SR-$1')
    .replace(/\bSUNSET\b/g, 'SS').replace(/\bSUNRISE\b/g, 'SR')
    .replace(/\b(SR|SS)\s*PLUS\s*(\d+)/g, '$1+$2')
    .replace(/\b(SR|SS)\s*MINUS\s*(\d+)/g, '$1-$2')
    .replace(/\bDLY\b/g, 'DAILY')
    .replace(/\s*-\s*/g, '-')
    // "FRI 1500-MON 0600" -> one token
    .replace(new RegExp(String.raw`(\d{4})-(${DOW.join('|')})\s+(\d{4})`, 'g'), '$1>$2$3')
    // "20 0500-21 1400" -> one token (a period from one day/time to another)
    .replace(/\b(\d{1,2}) (\d{4})-(\d{1,2}) (\d{4})\b/g, 'SPAN~$1~$2~$3~$4')
    // "OCT 26-DEC 11" -> one token
    .replace(new RegExp(String.raw`\b(${MONTHS.join('|')})\s*(\d{1,2})-(${MONTHS.join('|')})\s*(\d{1,2})\b`, 'g'), '$1$2~$3$4')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseTm(s: string): Tm | null {
  let m = /^(\d{2})(\d{2})$/.exec(s)
  if (m) {
    const h = Number(m[1]), mi = Number(m[2])
    if (h > 24 || mi > 59) return null
    return { kind: 'abs', min: h * 60 + mi }
  }
  m = /^(SR|SS)(?:([+-])(\d{1,3}))?$/.exec(s)
  if (m) return { kind: m[1] === 'SR' ? 'sr' : 'ss', offsetMin: m[3] ? (m[2] === '-' ? -1 : 1) * Number(m[3]) : 0 }
  return null
}

const dowIdx = (s: string) => DOW.indexOf(s)

function daySet(from: string, to?: string): boolean[] | null {
  const a = dowIdx(from), b = to ? dowIdx(to) : a
  if (a < 0 || b < 0) return null
  const out = new Array<boolean>(7).fill(false)
  for (let i = a; ; i = (i + 1) % 7) { out[i] = true; if (i === b) break }
  return out
}

const or = (a: boolean[] | null, b: boolean[]): boolean[] => (a ? a.map((v, i) => v || b[i]!) : b)

// ── D-style parser ─────────────────────────────────────────────────────────

interface DateCtx { year: number; month: number; lastDay: number }

const utcDay = (y: number, m: number, d: number) => Date.UTC(y, m, d)

function parseSegments(norm: string, base: Date): { entries: Entry[]; ok: boolean } {
  const entries: Entry[] = []
  const ctx: DateCtx = { year: base.getUTCFullYear(), month: base.getUTCMonth(), lastDay: 0 }
  // selectors carried over to a following time-only segment ("DAILY 0600-1000, 1115-1600")
  let carry: { days: boolean[] | null; dates: Array<[number, number]> | null } = { days: null, dates: null }

  for (const seg of norm.split(',').map(x => x.trim()).filter(Boolean)) {
    let days: boolean[] | null = null
    let dates: Array<[number, number]> | null = null
    let sawSel = false, sawTime = false
    let any = false
    for (const tok of seg.split(' ')) {
      let m: RegExpExecArray | null
      if (tok === 'DAILY' || tok === 'EVERY') {
        if (sawTime) { days = null; dates = null; sawTime = false }
        sawSel = true; any = true; continue
      }
      if ((m = new RegExp(String.raw`^(${DOW.join('|')})(?:-(${DOW.join('|')}))?$`).exec(tok))) {
        if (sawTime) { days = null; dates = null; sawTime = false }
        const s = daySet(m[1]!, m[2]); if (!s) return { entries, ok: false }
        days = or(days, s); sawSel = true; any = true; continue
      }
      if ((m = new RegExp(String.raw`^(${MONTHS.join('|')})(\d{1,2})~(${MONTHS.join('|')})(\d{1,2})$`).exec(tok))) {
        if (sawTime) { days = null; dates = null; sawTime = false }
        const m1 = MONTHS.indexOf(m[1]!), m2 = MONTHS.indexOf(m[3]!)
        if (m1 < ctx.month) ctx.year++ // month before the effective one = next year
        const y2 = m2 < m1 ? ctx.year + 1 : ctx.year
        ;(dates ??= []).push([utcDay(ctx.year, m1, Number(m[2])), utcDay(y2, m2, Number(m[4])) + DAY_MS])
        ctx.month = m2; ctx.year = y2; ctx.lastDay = Number(m[4]); sawSel = true; any = true; continue
      }
      if (MONTHS.includes(tok)) {
        if (sawTime) { days = null; dates = null; sawTime = false }
        const mi = MONTHS.indexOf(tok)
        if (mi < ctx.month) ctx.year++
        ctx.month = mi; ctx.lastDay = 0; sawSel = true; any = true; continue
      }
      if ((m = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(tok))) {
        if (sawTime) { days = null; dates = null; sawTime = false }
        const d1 = Number(m[1]), d2 = m[2] ? Number(m[2]) : d1
        if (d1 < 1 || d1 > 31 || d2 < d1 || d2 > 31) return { entries, ok: false }
        if (d1 < ctx.lastDay) { ctx.month++; if (ctx.month > 11) { ctx.month = 0; ctx.year++ } }
        ;(dates ??= []).push([utcDay(ctx.year, ctx.month, d1), utcDay(ctx.year, ctx.month, d2) + DAY_MS])
        ctx.lastDay = d2; sawSel = true; any = true; continue
      }
      // times
      const sel = sawSel ? { days, dates } : carry
      if ((m = /^SPAN~(\d{1,2})~(\d{4})~(\d{1,2})~(\d{4})$/.exec(tok))) {
        const d1 = Number(m[1]), d2 = Number(m[3])
        const a = parseTm(m[2]!), z = parseTm(m[4]!)
        if (!a || !z || a.kind !== 'abs' || z.kind !== 'abs' || d1 < 1 || d1 > 31 || d2 < 1 || d2 > 31) return { entries, ok: false }
        if (d1 < ctx.lastDay) { ctx.month++; if (ctx.month > 11) { ctx.month = 0; ctx.year++ } }
        const startMs = utcDay(ctx.year, ctx.month, d1) + a.min * 60_000
        if (d2 < d1) { ctx.month++; if (ctx.month > 11) { ctx.month = 0; ctx.year++ } }
        const endMs = utcDay(ctx.year, ctx.month, d2) + z.min * 60_000
        if (endMs <= startMs) return { entries, ok: false }
        entries.push({ days: null, dates: null, start: a, end: z, endDow: null, span: [startMs, endMs] })
        ctx.lastDay = d2; sawTime = true; any = true; continue
      }
      if (tok === 'H24') {
        entries.push({ days: sel.days, dates: sel.dates, start: { kind: 'abs', min: 0 }, end: { kind: 'abs', min: 1440 }, endDow: null })
        sawTime = true; any = true; continue
      }
      if ((m = new RegExp(String.raw`^(${TM})>(${DOW.join('|')})(\d{4})$`).exec(tok))) {
        const a = parseTm(m[1]!), b = parseTm(m[3]!)
        if (!a || !b) return { entries, ok: false }
        entries.push({ days: sel.days, dates: sel.dates, start: a, end: b, endDow: dowIdx(m[2]!) })
        sawTime = true; any = true; continue
      }
      if ((m = new RegExp(String.raw`^(${TM})-(${TM})$`).exec(tok))) {
        const a = parseTm(m[1]!), b = parseTm(m[2]!)
        if (!a || !b) return { entries, ok: false }
        entries.push({ days: sel.days, dates: sel.dates, start: a, end: b, endDow: null })
        sawTime = true; any = true; continue
      }
      return { entries, ok: false }
    }
    if (!any) continue
    if (sawSel) carry = { days, dates }
  }
  return { entries, ok: entries.length > 0 }
}

function parseExclusions(s: string, base: Date): { days: boolean[] | null; dates: Array<[number, number]> } | null {
  let days: boolean[] | null = null
  const dates: Array<[number, number]> = []
  let month = -1
  let year = base.getUTCFullYear()
  for (const tok of s.split(/[\s,]+/).filter(Boolean)) {
    if (dowIdx(tok) >= 0) { days = or(days, daySet(tok)!); continue }
    const mi = MONTHS.indexOf(tok)
    if (mi >= 0) { if (mi < base.getUTCMonth()) year++; month = mi; continue }
    if (/^\d{1,2}$/.test(tok) && month >= 0) { dates.push([utcDay(year, month, Number(tok)), utcDay(year, month, Number(tok)) + DAY_MS]); continue }
    return null
  }
  return { days, dates }
}

function parseD(raw: string, base: Date): NotamSchedule | null {
  let norm = normalise(raw)
  let excl: { days: boolean[] | null; dates: Array<[number, number]> } | null = null
  const ex = /\bEXC(?:EPT)?\b(.*)$/.exec(norm)
  if (ex) {
    excl = parseExclusions(ex[1]!, base)
    if (!excl) return null
    norm = norm.slice(0, ex.index).trim().replace(/,$/, '')
  }
  const { entries, ok } = parseSegments(norm, base)
  if (!ok) return null
  return { entries, excludeDays: excl?.days ?? null, excludeDates: excl?.dates ?? [], holidays: false }
}

// ── schedule written at the start of E) ────────────────────────────────────

const LEAD = new RegExp(
  String.raw`^((?:(?:DAILY|EVERY|${DOW.join('|')})(?:-(?:${DOW.join('|')}))?[ ,]+)*)(${TM}-${TM})(?![A-Z0-9])`,
)

function parseLead(text: string, base: Date): NotamSchedule | null {
  const head = normalise(text.slice(0, 160))
  const m = LEAD.exec(head)
  if (!m) return null
  // A bare time range with no day word is too easily something else
  // ("1200-1500FT ..."), require a day word or DAILY in front.
  if (!m[1] || !m[1].trim()) return null
  const s = parseD(`${m[1]!.replace(/,\s*(?=DAILY)/, ' ')} ${m[2]}`, base)
  if (!s) return null
  s.holidays = /\bEXCEPT?\b[^.]{0,40}\bHOLIDAYS?\b/.test(head)
  return s
}

export function parseNotamSchedule(n: {
  itemD?: string | null
  text?: string | null
  effective?: string | null
}): NotamSchedule | null {
  const eff = n.effective ? Date.parse(n.effective) : NaN
  const base = new Date(Number.isNaN(eff) ? Date.now() : eff)
  try {
    if (n.itemD && n.itemD.trim()) {
      const s = parseD(n.itemD, base)
      if (s) { s.holidays = /\bHOLIDAYS?\b/i.test(n.itemD); return s }
    }
    if (n.text) return parseLead(n.text, base)
  } catch { /* unparseable -> treated as always in force */ }
  return null
}

// ── evaluation ─────────────────────────────────────────────────────────────

/**
 * Does the schedule have an active interval overlapping [fromMs, toMs]?
 * True when it can't tell (polar sun times), so a NOTAM is never hidden by
 * a guess.
 */
export function scheduleOverlaps(
  s: NotamSchedule, fromMs: number, toMs: number, pos: { lat: number; lon: number },
): boolean {
  const firstDay = Math.floor(fromMs / DAY_MS) * DAY_MS - 8 * DAY_MS // entries can span into later days
  const lastDay = Math.floor(toMs / DAY_MS) * DAY_MS
  const resolve = (dayMs: number, t: Tm): number | null => {
    if (t.kind === 'abs') return dayMs + t.min * 60_000
    const sun = sunriseSunset(pos.lat, pos.lon, new Date(dayMs + 12 * 3_600_000))
    const at = t.kind === 'sr' ? sun.rise : sun.set
    return at ? at.getTime() + t.offsetMin * 60_000 : null
  }
  for (const e of s.entries) if (e.span && e.span[0] < toMs && e.span[1] > fromMs) return true
  for (let d = firstDay; d <= lastDay; d += DAY_MS) {
    const dow = new Date(d).getUTCDay()
    if (s.excludeDays?.[dow]) continue
    if (s.excludeDates.some(([a, b]) => d >= a && d < b)) continue
    for (const e of s.entries) {
      if (e.span) continue
      if (e.days && !e.days[dow]) continue
      if (e.dates && !e.dates.some(([a, b]) => d >= a && d < b)) continue
      const a = resolve(d, e.start)
      const endDay = e.endDow !== null ? d + ((e.endDow - dow + 7) % 7 || 0) * DAY_MS : d
      const b = resolve(endDay, e.end)
      if (a === null || b === null) return true
      const end = b <= a ? b + DAY_MS : b
      if (a < toMs && end > fromMs) return true
    }
  }
  return false
}

/** Position to evaluate sun times at: the NOTAM's own point or first vertex. */
export function notamPosition(n: {
  lat: number | null; lon: number | null
  polygon?: { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] } | null
}): { lat: number; lon: number } | null {
  if (n.lat !== null && n.lon !== null) return { lat: n.lat, lon: n.lon }
  const p = n.polygon
  const v = p ? (p.type === 'Polygon' ? p.coordinates[0]?.[0] : p.coordinates[0]?.[0]?.[0]) : null
  return v ? { lat: v[1]!, lon: v[0]! } : null
}

// ── NotamItem helpers ──────────────────────────────────────────────────────

interface ScheduledNotam {
  text: string
  effective?: string | null
  icao?: { schedule?: string | null } | null
  lat: number | null
  lon: number | null
  polygon?: Parameters<typeof notamPosition>[0]['polygon']
}

const _parsed = new WeakMap<object, NotamSchedule | null>()

/** The NOTAM's schedule (D, else leading E text), parsed once per record. */
export function notamScheduleFor(n: ScheduledNotam): NotamSchedule | null {
  if (_parsed.has(n)) return _parsed.get(n)!
  const s = parseNotamSchedule({ itemD: n.icao?.schedule, text: n.text, effective: n.effective })
  _parsed.set(n, s)
  return s
}

/**
 * True only when the NOTAM has a schedule we understand and none of its
 * active periods touches [fromMs, toMs]. Unknown schedule, unknown position
 * -> false (never hide on a guess).
 */
export function isOffSchedule(n: ScheduledNotam, fromMs: number, toMs: number): boolean {
  const s = notamScheduleFor(n)
  if (!s) return false
  const pos = notamPosition(n)
  if (!pos) return false
  return !scheduleOverlaps(s, fromMs, toMs, pos)
}
