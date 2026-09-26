/**
 * Bounded undo/redo history of immutable snapshots (framework-agnostic).
 *
 * `record(prev, now)` is called with the state *before* a change. Changes
 * arriving within `coalesceMs` of the previous record are merged into the
 * same undo step -- one user action often issues several state updates back
 * to back (e.g. set waypoints, then set leg overrides), and a pilot expects
 * one Undo to revert the whole action, not half of it.
 */
export interface UndoHistory<T> {
  past: T[]
  future: T[]
  lastRecordAt: number
}

export const emptyHistory = <T>(): UndoHistory<T> => ({ past: [], future: [], lastRecordAt: -Infinity })

export function recordChange<T>(
  h: UndoHistory<T>, before: T, now: number, coalesceMs = 400, limit = 50,
): UndoHistory<T> {
  if (now - h.lastRecordAt < coalesceMs && h.past.length > 0) {
    // Same action: keep the snapshot from its start, drop any redo branch.
    return { past: h.past, future: [], lastRecordAt: now }
  }
  const past = [...h.past, before]
  if (past.length > limit) past.splice(0, past.length - limit)
  return { past, future: [], lastRecordAt: now }
}

/** Returns the snapshot to restore plus the new history, or null if nothing to undo. */
export function undo<T>(h: UndoHistory<T>, current: T): { state: T; history: UndoHistory<T> } | null {
  if (h.past.length === 0) return null
  const state = h.past[h.past.length - 1]
  return { state, history: { past: h.past.slice(0, -1), future: [current, ...h.future], lastRecordAt: -Infinity } }
}

export function redo<T>(h: UndoHistory<T>, current: T): { state: T; history: UndoHistory<T> } | null {
  if (h.future.length === 0) return null
  const [state, ...rest] = h.future
  return { state, history: { past: [...h.past, current], future: rest, lastRecordAt: -Infinity } }
}
