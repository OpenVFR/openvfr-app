/**
 * Smoothed climb / descent rate from successive altitude fixes.
 *
 * GPS altitude jitters by several metres between fixes, so a raw difference
 * over one second reads hundreds of ft/min of climb or descent in level
 * flight. An exponential average (time constant `tauMs`) keeps the number
 * usable for projecting a minute or two ahead.
 */

export type ClimbState = { altFt: number; ts: number; rateFpm: number }

/** A gap longer than this restarts the estimate. */
const STALE_MS = 30_000
/** Ticks closer together than this are ignored (effect re-runs, not new fixes). */
const MIN_DT_MS = 500

export function updateClimbRate(
  prev: ClimbState | null,
  altFt: number,
  now: number,
  tauMs: number = 5_000,
): ClimbState {
  if (!prev || now - prev.ts > STALE_MS || now < prev.ts) return { altFt, ts: now, rateFpm: 0 }
  const dt = now - prev.ts
  if (dt < MIN_DT_MS) return prev
  const inst = (altFt - prev.altFt) / (dt / 60_000)
  const alpha = 1 - Math.exp(-dt / tauMs)
  return { altFt, ts: now, rateFpm: prev.rateFpm + alpha * (inst - prev.rateFpm) }
}
