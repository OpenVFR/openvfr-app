/**
 * Recent-alert log: what the alert stack showed lately, so a card that was
 * dismissed, timed out or pushed into a chip can still be looked up.
 *
 * Pure, mutation-free helpers; the apps keep the list in a ref.
 */

export type LoggableAlert = {
  key:      string
  severity: 'red' | 'yellow' | 'blue'
  badge:    string
  title:    string
  meta?:    string
}

export type AlertLogEntry = LoggableAlert & {
  /** First shown. */
  at:     number
  /** Last tick it was still shown. */
  lastAt: number
}

export const ALERT_LOG_MAX = 30
export const ALERT_LOG_MAX_AGE_MS = 30 * 60_000
/** The same key shown again within this long counts as the same occurrence (flapping). */
export const ALERT_LOG_MERGE_MS = 60_000

export type RecordResult = { log: AlertLogEntry[]; added: boolean }

/**
 * Fold the items shown now into the log. `prevKeys` are the keys shown on the
 * previous tick: an item that was not shown then is a new occurrence, unless
 * the same key was logged less than ALERT_LOG_MERGE_MS ago.
 */
export function recordAlerts(
  log: readonly AlertLogEntry[],
  shown: readonly LoggableAlert[],
  prevKeys: ReadonlySet<string>,
  now: number,
): RecordResult {
  const next = log.filter(e => now - e.lastAt <= ALERT_LOG_MAX_AGE_MS).map(e => ({ ...e }))
  let added = next.length !== log.length
  for (const item of shown) {
    let idx = -1
    for (let i = next.length - 1; i >= 0; i--) if (next[i].key === item.key) { idx = i; break }
    const recent = idx >= 0 && now - next[idx].lastAt < ALERT_LOG_MERGE_MS
    if (recent) {
      next[idx] = { ...next[idx], ...item, at: next[idx].at, lastAt: now }
    } else if (!prevKeys.has(item.key) || idx < 0) {
      next.push({ ...item, at: now, lastAt: now })
      added = true
    }
  }
  return { log: next.slice(-ALERT_LOG_MAX), added }
}

/** Entries not currently on screen, newest first. */
export function pastAlerts(log: readonly AlertLogEntry[], shownKeys: ReadonlySet<string>): AlertLogEntry[] {
  return log.filter(e => !shownKeys.has(e.key)).sort((a, b) => b.lastAt - a.lastAt)
}

/** "HH:MMZ" (UTC). */
export function alertLogTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`
}
