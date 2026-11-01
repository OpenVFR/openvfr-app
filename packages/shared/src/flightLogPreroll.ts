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
