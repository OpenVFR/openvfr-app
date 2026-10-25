/**
 * Debounce for the alert stack: a card only appears once its condition has
 * held for `enterMs`, and once shown it stays for at least `minShowMs` and
 * `lingerMs` after the condition ended. Without this, an obstacle at the edge
 * of its trigger area, or a GPS wobble across an airspace boundary, makes
 * cards pop in and out every few seconds.
 *
 * Pure: the caller keeps the returned `entries` and passes them back in on
 * the next tick.
 */

export type StableTiming = {
  /** Condition must hold this long before the item is shown. 0 = at once. */
  enterMs?:   number
  /** Once shown, stay at least this long. */
  minShowMs?: number
  /** After the condition ended, stay this long (flicker bridge). */
  lingerMs?:  number
}

export const STABLE_DEFAULTS = { enterMs: 2_000, minShowMs: 5_000, lingerMs: 2_000 } as const

export type StableEntry<T> = {
  item:      T
  firstSeen: number
  lastSeen:  number
  /** When the item first became visible; null while still pending. */
  shownAt:   number | null
}

export type StableResult<T> = {
  entries: Map<string, StableEntry<T>>
  /** Items to render, in the order they first became visible. */
  visible: T[]
  /** True while something is pending or lingering, so the caller must tick again. */
  needsTick: boolean
}

export function stabilize<T extends { key: string } & StableTiming>(
  prev: ReadonlyMap<string, StableEntry<T>>,
  current: readonly T[],
  now: number,
): StableResult<T> {
  const entries = new Map<string, StableEntry<T>>()
  let needsTick = false
  const present = new Set<string>()

  for (const item of current) {
    present.add(item.key)
    const old = prev.get(item.key)
    const e: StableEntry<T> = old
      ? { ...old, item, lastSeen: now }
      : { item, firstSeen: now, lastSeen: now, shownAt: null }
    if (e.shownAt === null) {
      const enter = item.enterMs ?? STABLE_DEFAULTS.enterMs
      if (now - e.firstSeen >= enter) e.shownAt = now
      else needsTick = true
    }
    entries.set(item.key, e)
  }

  for (const [key, old] of prev) {
    if (present.has(key) || old.shownAt === null) continue
    const linger  = old.item.lingerMs  ?? STABLE_DEFAULTS.lingerMs
    const minShow = old.item.minShowMs ?? STABLE_DEFAULTS.minShowMs
    if (now - old.lastSeen < linger || now - old.shownAt < minShow) {
      entries.set(key, old)
      needsTick = true
    }
  }

  const visible = [...entries.values()]
    .filter(e => e.shownAt !== null)
    .sort((a, b) => (a.shownAt as number) - (b.shownAt as number))
    .map(e => e.item)
  return { entries, visible, needsTick }
}
