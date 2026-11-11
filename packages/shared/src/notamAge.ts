/**
 * notamAge -- when a NOTAM was published, which are new, and newest-first order.
 * Publication time is the message's `issued` field (ISO); without it the
 * start of validity is the best stand-in for order, but never counts as "new".
 */
import type { NotamItem } from './fetchNotam'

type A = Pick<NotamItem, 'effective'> & { icao?: { issued?: string | null } | null }

/** A NOTAM published less than this long ago is "new". */
export const NOTAM_NEW_MS = 12 * 3_600_000

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

export const notamIssuedMs = (n: A): number | null => ms(n.icao?.issued)

export function isNewNotam(n: A, nowMs: number = Date.now()): boolean {
  const t = notamIssuedMs(n)
  return t !== null && t <= nowMs + 3_600_000 && nowMs - t < NOTAM_NEW_MS
}

/** Newest published first; no issue time -> by start of validity; stable otherwise. */
export function sortNewestFirst<T extends A>(notams: readonly T[]): T[] {
  const key = (n: T) => notamIssuedMs(n) ?? ms(n.effective) ?? 0
  return notams.map((n, i) => ({ n, i })).sort((a, b) => key(b.n) - key(a.n) || a.i - b.i).map((x) => x.n)
}
