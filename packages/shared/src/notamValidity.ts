/**
 * Validity-window status for a NOTAM (or anything with an ISO start/end):
 * active now, upcoming (with a countdown when within 24h), or ended.
 *
 * Charted airspace data carries no structured activation schedule (only
 * free-text remarks such as "active by NOTAM"), so a matched NOTAM's own
 * B)/C) window is the one machine-readable activation signal available --
 * this turns it into an at-a-glance status instead of making the pilot
 * compare two UTC timestamps against the clock in their head.
 */

import { isOffSchedule, nextScheduleChange, notamPosition, notamScheduleFor } from './notamSchedule'

export type ValidityState = 'active' | 'scheduled' | 'upcoming' | 'ended' | 'unknown'

export interface ValidityStatus {
  state: ValidityState
  /** Short badge text: "Active", "Starts in 2h 15m", "Upcoming", "Ended". */
  label: string
}

const parse = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

function fmtDuration(ms: number): string {
  const totalMin = Math.max(1, Math.round(ms / 60_000))
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

export function notamValidity(
  effective: string | null | undefined,
  expires: string | null | undefined,
  now: number = Date.now(),
): ValidityStatus {
  const start = parse(effective)
  const end = parse(expires) // null = permanent / estimated / unparseable end
  if (start === null && end === null) return { state: 'unknown', label: '' }
  if (end !== null && now >= end) return { state: 'ended', label: 'Ended' }
  if (start !== null && now < start) {
    const until = start - now
    return {
      state: 'upcoming',
      label: until <= 24 * 3_600_000 ? `Starts in ${fmtDuration(until)}` : 'Upcoming',
    }
  }
  return { state: 'active', label: 'Active' }
}

/** "14:05Z" for the given instant (UTC). */
export function fmtUtcClock(now: number = Date.now()): string {
  const d = new Date(now)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`
}

/** "10:00Z" on the same UTC day as `now`, else "Wed 10:00Z". */
function fmtUtcDayClock(ms: number, now: number): string {
  const same = Math.floor(ms / 86_400_000) === Math.floor(now / 86_400_000)
  return same ? fmtUtcClock(ms) : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(ms).getUTCDay()]} ${fmtUtcClock(ms)}`
}

/**
 * notamValidity plus the NOTAM's own schedule (item D / leading E text):
 * inside B)-C) but outside every scheduled period within `horizonMs` ->
 * state 'scheduled' ("Off schedule"), not 'active'. NOTAMs without a
 * schedule we understand are unaffected.
 */
export function notamStatus(
  n: Parameters<typeof isOffSchedule>[0] & { expires?: string | null },
  now: number = Date.now(),
  horizonMs = 0,
): ValidityStatus {
  const v = notamValidity(n.effective, n.expires, now)
  if (v.state === 'active' && isOffSchedule(n, now, now + Math.max(horizonMs, 60_000))) {
    // When it next applies, if that is within two days: "Off schedule · next Wed 10:00Z".
    const sched = notamScheduleFor(n)
    const pos = notamPosition(n)
    const next = sched && pos ? nextScheduleChange(sched, pos, now, 48 * 3_600_000, true) : null
    const end = n.expires ? Date.parse(n.expires) : NaN
    if (next !== null && (Number.isNaN(end) || next < end)) {
      return { state: 'scheduled', label: `Off schedule · next ${fmtUtcDayClock(next, now)}` }
    }
    return { state: 'scheduled', label: 'Off schedule' }
  }
  return v
}
