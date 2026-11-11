/**
 * aerodromeClosure -- is an aerodrome closed by one of its own NOTAMs, now or
 * soon, and until when?
 *
 * A closure NOTAM is Q-code subject FA (aerodrome), condition LC (closed), or
 * -- when the Q-code is missing -- text such as "AD CLSD" / "AERODROME CLOSED".
 * Runway closures (QMRLC) are not an aerodrome closure and are left alone.
 *
 * Fail-safe: a closure is never dropped on a guess.
 *  - A NOTAM with a schedule we cannot read still reports "closed at times".
 *  - "Closed except ..." / "closed to ..." / PPR wording is reported as a
 *    partial closure ("Restricted"), never as a full one.
 *  - A closure that only applies at scheduled times is never reported as
 *    "closed now" outside those times.
 */
import type { NotamItem } from './fetchNotam'
import { fmtUtcDayClock, notamValidity } from './notamValidity'
import { SCHEDULE_LOOKAHEAD_MS, nextScheduleChange, notamScheduleFor, scheduleOverlaps } from './notamSchedule'

export type ClosureState =
  /** In force right now. */
  | 'closed'
  /** In force at scheduled times only, and not at this moment. */
  | 'scheduled'
  /** Starts within the look-ahead window. */
  | 'soon'

export interface AerodromeClosure {
  state: ClosureState
  /** Not a full closure: "except ...", "to ... traffic", PPR. */
  partial: boolean
  notam: NotamItem
  /** closed: when it ends (ms), null when open-ended or unknown. soon: when it starts. scheduled: when the next closed period starts, null if unknown. */
  untilMs: number | null
  /** The end is an estimate (C-line "EST"). */
  estimated: boolean
}

/** Look-ahead for a closure that has not started yet. */
export const CLOSURE_SOON_MS = 24 * 3_600_000

/** Conditions meaning "not in force any more / no area": same as the pre-flight NOTAM areas. */
const NOT_IN_FORCE = new Set(['TT', 'AW', 'CD', 'CC', 'CN'])

const TEXT_CLOSED =
  /\b(?:AD|AERODROME|AIRDROME|AIRPORT|AIRFIELD|HELIPORT|HELIPAD)\b[^.\n]{0,25}\b(?:CLSD|CLOSED)\b/i
/** The rest of the sentence after the closure word: that is where a limit such as "EXC ..." or "TO ..." belongs. */
const CLOSED_CLAUSE = /\b(?:CLSD|CLOSED)\b([^.]*)/i
const EXCEPT_REAL = /\b(?:EXC|EXCL|EXCEPT|EXCEPTING)\b(?!\s+(?:HOL|HOLS|HOLIDAYS?|PUBLIC|SAT|SUN|MON|TUE|WED|THU|FRI|\d))/i
const CLOSED_TO = /^\s+TO\s+(?!ALL\b)[A-Z -]{0,40}?\b(?:TFC|TRAFFIC|ACFT|AIRCRAFT|OPS|OPERATIONS|FLIGHTS?)\b/i
const PPR = /\bPPR\b/i

/** Subject + condition of a Q-code ("QFALC" -> "FA"+"LC"), null without one. */
export function qParts(q: string | null | undefined): { subject: string; cond: string } | null {
  if (!q) return null
  const c = q.trim().toUpperCase()
  if (!/^Q[A-Z]{4}$/.test(c)) return null
  return { subject: c.slice(1, 3), cond: c.slice(3, 5) }
}

/** Does this NOTAM close the aerodrome (fully or partly)? */
export function isAerodromeClosureNotam(n: Pick<NotamItem, 'qCode' | 'text'>): boolean {
  const q = qParts(n.qCode)
  if (q) {
    if (NOT_IN_FORCE.has(q.cond)) return false
    if (q.subject === 'FA' && q.cond === 'LC') return true
    if (q.subject === 'FA' && q.cond !== 'XX') return false
    // Another subject (runway, taxiway, lighting, ...) is not the aerodrome closing, even if the text says so.
    if (q.subject !== 'XX' && q.subject !== 'FA') return false
  }
  return TEXT_CLOSED.test(n.text)
}

function isPartial(text: string): boolean {
  const m = CLOSED_CLAUSE.exec(text)
  if (!m) return false
  const rest = m[1]!
  return EXCEPT_REAL.test(rest) || CLOSED_TO.test(rest) || PPR.test(rest)
}

const MIN = 60_000

/**
 * The most relevant closure among an aerodrome's NOTAMs: one in force now
 * beats a scheduled one, which beats one that starts soon; a full closure
 * beats a partial one. Null when there is none.
 */
export function aerodromeClosure(
  notams: readonly NotamItem[],
  aerodrome: { lat: number; lon: number },
  nowMs: number = Date.now(),
): AerodromeClosure | null {
  const rank = (c: AerodromeClosure) =>
    (c.state === 'closed' ? 0 : c.state === 'scheduled' ? 2 : 4) + (c.partial ? 1 : 0)
  let best: AerodromeClosure | null = null
  for (const n of notams) {
    if (!isAerodromeClosureNotam(n)) continue
    const c = classify(n, aerodrome, nowMs)
    if (c && (!best || rank(c) < rank(best))) best = c
  }
  return best
}

function classify(
  n: NotamItem, ad: { lat: number; lon: number }, nowMs: number,
): AerodromeClosure | null {
  const v = notamValidity(n.effective, n.expires, nowMs)
  if (v.state === 'ended') return null
  const partial = isPartial(n.text)
  const estimated = !!n.icao?.estimated
  const endMs = n.expires ? Date.parse(n.expires) : NaN
  const end = Number.isNaN(endMs) ? null : endMs
  const startMs = n.effective ? Date.parse(n.effective) : NaN
  const base = { partial, notam: n, estimated }

  if (v.state === 'upcoming') {
    if (Number.isNaN(startMs) || startMs - nowMs > CLOSURE_SOON_MS) return null
    return { ...base, state: 'soon', untilMs: startMs }
  }

  const sched = notamScheduleFor(n)
  const itemD = n.icao?.schedule?.trim() || null
  if (!sched) {
    // A schedule we cannot read: say it is scheduled, do not claim "closed now" or "open".
    if (itemD) return { ...base, state: 'scheduled', untilMs: null }
    return { ...base, state: 'closed', untilMs: end }
  }

  const pos = n.lat !== null && n.lon !== null ? { lat: n.lat, lon: n.lon } : ad
  const inForce = scheduleOverlaps(sched, nowMs, nowMs + MIN, pos)
  if (inForce) {
    const off = nextScheduleChange(sched, pos, nowMs, SCHEDULE_LOOKAHEAD_MS, false)
    const until = off !== null ? (end !== null ? Math.min(off, end) : off) : end
    return { ...base, state: 'closed', untilMs: until }
  }
  const on = nextScheduleChange(sched, pos, nowMs, CLOSURE_SOON_MS * 2, true)
  const next = on !== null && (end === null || on < end) ? on : null
  return { ...base, state: 'scheduled', untilMs: next }
}

const whenText = fmtUtcDayClock

/** One-line pilot wording, e.g. "Closed now until 07:45Z", "Closed at scheduled times". */
export function closureLabel(c: AerodromeClosure, nowMs: number = Date.now()): string {
  const word = c.partial ? 'Restricted' : 'Closed'
  const est = c.estimated ? ' (est.)' : ''
  switch (c.state) {
    case 'closed':
      return c.untilMs !== null
        ? `${word} now until ${whenText(c.untilMs, nowMs)}${est}`
        : `${word} now`
    case 'soon':
      return `${word} from ${whenText(c.untilMs!, nowMs)}`
    case 'scheduled':
      return c.untilMs !== null
        ? `${word} at scheduled times, next from ${whenText(c.untilMs, nowMs)}`
        : `${word} at scheduled times`
  }
}
