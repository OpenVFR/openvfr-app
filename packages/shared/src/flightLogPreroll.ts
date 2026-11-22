/**
 * flightLogPreroll: the start of a flight log before the moment the flight
 * was detected.
 *
 * Takeoff detection needs the aircraft well above the terrain (see
 * autoFlyDetect), so flying mode and the log start some 30-60 s after
 * liftoff. The app keeps the last few minutes of fixes; when a new log
 * starts, the fixes from the takeoff roll on are put in front of it, so the
 * log keeps its real start time, the roll, and the departure aerodrome
 * (named from the first track point).
 */

import { quickDistNm } from './quickDist'

/** How far back fixes are kept for this. */
export const PREROLL_KEEP_MS = 5 * 60_000
/** A longer gap between fixes ends the run (the GPS was off, the app paused). */
export const PREROLL_MAX_GAP_MS = 15_000

export interface PrerollFix { lat: number; lng: number; altFt: number; spdKts: number; trkDeg: number; ts: number }

/** Drops fixes older than PREROLL_KEEP_MS before `nowMs` (keeps order). */
export function trimPreroll<T extends { ts: number }>(fixes: T[], nowMs: number): T[] {
  const from = fixes.findIndex(f => nowMs - f.ts <= PREROLL_KEEP_MS)
  return from < 0 ? [] : from === 0 ? fixes : fixes.slice(from)
}

/**
 * The fixes of the current takeoff run: going back from the newest, every
 * fix at or above `rollKts` without a gap over PREROLL_MAX_GAP_MS, plus the
 * one fix before them (where the roll began). [] when the newest fix is
 * slower than `rollKts`.
 */
export function takeoffRun<T extends PrerollFix>(fixes: T[], rollKts: number): T[] {
  let i = fixes.length - 1
  if (i < 0 || fixes[i]!.spdKts < rollKts) return []
  while (i > 0 && fixes[i - 1]!.spdKts >= rollKts && fixes[i]!.ts - fixes[i - 1]!.ts <= PREROLL_MAX_GAP_MS) i--
  if (i > 0 && fixes[i]!.ts - fixes[i - 1]!.ts <= PREROLL_MAX_GAP_MS) i--
  return fixes.slice(i)
}

/** A kept fix this close after the log's last point (ms) is that same point, not a new one. */
const SAME_FIX_EPSILON_MS = 500
/** A log not written for longer than this (ms) has a hole worth filling. */
const HOLE_MIN_MS = 5_000

/**
 * The kept fixes that fill a hole in a log: those after its last recorded point (`lastTs`), when the log has not
 * been written for more than HOLE_MIN_MS. Flying mode can stop in the air (a hover read as a landing, the
 * pilot's own stop) while the fixes keep coming; when it starts again the hole is filled from here instead of
 * being shown as a recording gap. [] while the log is being written normally.
 */
export function fixesToFillHole<T extends { ts: number }>(fixes: T[], lastTs: number, nowMs: number): T[] {
  if (nowMs - lastTs <= HOLE_MIN_MS) return []
  return fixes.filter(f => f.ts > lastTs + SAME_FIX_EPSILON_MS && f.ts < nowMs)
}

/** The parts of a recorder's state that appending fixes to its log changes. */
export interface HoleFillState<T extends PrerollFix> {
  track: T[]; distanceNm: number; maxAltFt: number; prevLat: number; prevLng: number; lastTrackMs: number; dirty: boolean
}

/** Appends the kept fixes that fill a hole to the recorder's open log (see fixesToFillHole) and updates its totals. */
export function fillLogHole<T extends PrerollFix>(s: HoleFillState<T>, kept: T[], nowMs: number): void {
  const last = s.track[s.track.length - 1]
  if (!last) return
  let prev = last
  for (const p of fixesToFillHole(kept, last.ts, nowMs)) {
    s.distanceNm += quickDistNm(prev.lat, prev.lng, p.lat, p.lng)
    s.maxAltFt = Math.max(s.maxAltFt, p.altFt)
    s.track.push(p)
    prev = p
  }
  if (prev === last) return
  s.prevLat = prev.lat; s.prevLng = prev.lng; s.lastTrackMs = prev.ts; s.dirty = true
}
