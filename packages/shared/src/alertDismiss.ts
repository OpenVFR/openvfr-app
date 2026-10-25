/**
 * Dismissal that lasts as long as the hazard does.
 *
 * A fixed re-arm timer brings a dismissed alert straight back while the pilot
 * is still next to the same hazard. Here a dismissed key stays muted for as
 * long as it keeps being detected; only after it has been absent for
 * `rearmMs` (the hazard was left behind) is it allowed to alert again. The
 * grace period also stops a hazard at the edge of its trigger area from
 * re-alerting on a GPS wobble.
 */

/** Hazard must be gone this long before a dismissed alert can come back. */
export const DISMISS_GONE_REARM_MS = 60_000

/**
 * `dismissed` maps key to the last time the hazard was seen (or the dismissal
 * time). Mutates it. Returns `found` without the muted entries.
 */
export function filterDismissed<T extends { key: string }>(
  dismissed: Map<string, number>,
  found: readonly T[],
  now: number,
  rearmMs: number = DISMISS_GONE_REARM_MS,
): T[] {
  if (dismissed.size === 0) return found as T[]
  const seen = new Set<string>()
  for (const f of found) seen.add(f.key)
  for (const [key, ts] of dismissed) {
    if (seen.has(key)) dismissed.set(key, now)
    else if (now - ts >= rearmMs) dismissed.delete(key)
  }
  return found.filter(f => !dismissed.has(f.key))
}
