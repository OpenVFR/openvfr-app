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

import { isOffSchedule } from './notamSchedule'

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
    return { state: 'scheduled', label: 'Off schedule' }
  }
  return v
}
