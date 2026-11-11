/**
 * notamTriage -- the pilot's own "read" and "hidden" marks on NOTAMs.
 *
 * A mark belongs to one version of a NOTAM: the key is its unique id plus its
 * effective date, so a re-issue with a new date shows up fresh instead of
 * staying hidden. Marks only change how a list is drawn (read = dimmed,
 * hidden = folded under "Hidden by you"); the NOTAM stays in briefings, the
 * pre-flight check and alerts.
 *
 * Some NOTAMs can never be hidden: anything that closes the aerodrome, and
 * warnings / restrictions on airspace (Q-code subjects W*, R*), so a pilot
 * cannot fold away what the flight depends on.
 */
import type { NotamItem } from './fetchNotam'
import { isAerodromeClosureNotam } from './aerodromeClosure'

export interface NotamTriage {
  /** Keys, oldest first. */
  read: string[]
  hidden: string[]
}

export const EMPTY_TRIAGE: NotamTriage = { read: [], hidden: [] }

/** Oldest marks fall off beyond this, so storage cannot grow without bound. */
export const TRIAGE_MAX = 500

export const triageKey = (n: Pick<NotamItem, 'nmsId' | 'effective'>): string => `${n.nmsId}|${n.effective ?? ''}`

/** False for NOTAMs the pilot must always see in the list. */
export function canHideNotam(n: Pick<NotamItem, 'qCode' | 'text'>): boolean {
  if (isAerodromeClosureNotam(n)) return false
  const q = n.qCode?.trim().toUpperCase() ?? ''
  const subject = /^Q[A-Z]{4}$/.test(q) ? q.slice(1, 3) : ''
  if (subject.startsWith('W') || subject.startsWith('R')) return false
  return true
}

function add(list: readonly string[], key: string): string[] {
  const next = list.filter((k) => k !== key)
  next.push(key)
  return next.length > TRIAGE_MAX ? next.slice(next.length - TRIAGE_MAX) : next
}

export const markRead = (t: NotamTriage, key: string): NotamTriage =>
  t.read.includes(key) ? t : { ...t, read: add(t.read, key) }

export const hide = (t: NotamTriage, key: string): NotamTriage => ({ ...t, hidden: add(t.hidden, key) })

export const unhide = (t: NotamTriage, key: string): NotamTriage =>
  t.hidden.includes(key) ? { ...t, hidden: t.hidden.filter((k) => k !== key) } : t

/** Defensive parse of stored JSON: anything unexpected becomes an empty list. */
export function parseTriage(raw: unknown): NotamTriage {
  const o = typeof raw === 'string' ? safeJson(raw) : raw
  const strs = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-TRIAGE_MAX) : []
  if (!o || typeof o !== 'object') return EMPTY_TRIAGE
  const r = o as Record<string, unknown>
  return { read: strs(r.read), hidden: strs(r.hidden) }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

/** Split a list into what to show and what the pilot folded away. */
export function splitHidden<T extends Pick<NotamItem, 'nmsId' | 'effective' | 'qCode' | 'text'>>(
  notams: readonly T[], t: NotamTriage,
): { shown: T[]; hidden: T[] } {
  const hiddenSet = new Set(t.hidden)
  const shown: T[] = []
  const hidden: T[] = []
  for (const n of notams) {
    // A mark on something that can no longer be hidden is ignored.
    if (hiddenSet.has(triageKey(n)) && canHideNotam(n)) hidden.push(n)
    else shown.push(n)
  }
  return { shown, hidden }
}
