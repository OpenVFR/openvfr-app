/**
 * Shared poller: one timer and one request stream per key, however many
 * components subscribe. The last result is kept after the last subscriber
 * leaves, so a component that mounts again (tab switch, section reopened)
 * gets it at once and a fresh request is made only when it is older than the
 * interval.
 */
interface Entry<T> {
  listeners: Set<(d: T) => void>
  errorListeners: Set<(err: unknown) => void>
  data: T | undefined
  at: number
  timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | null
  fetcher: () => Promise<T>
}

const entries = new Map<string, Entry<unknown>>()
/** Last result per key, kept for a later subscriber. Capped: keys can come from region sets and routes, and each result is a whole list. */
const lastKnown = new Map<string, { data: unknown; at: number }>()
const MAX_KEPT = 20
function keep(key: string, data: unknown, at: number): void {
  lastKnown.delete(key)  // re-insert: Map order is then oldest-first
  lastKnown.set(key, { data, at })
  while (lastKnown.size > MAX_KEPT) lastKnown.delete(lastKnown.keys().next().value as string)
}

export function subscribePoll<T>(
  key: string,
  fetcher: () => Promise<T>,
  intervalMs: number,
  onData: (d: T) => void,
  /** Called when a request fails (the last good data stays valid). */
  onError?: (err: unknown) => void,
): () => void {
  let e = entries.get(key) as Entry<T> | undefined
  if (!e) {
    const kept = lastKnown.get(key)
    const created: Entry<T> = { listeners: new Set(), errorListeners: new Set(), data: kept?.data as T | undefined, at: kept?.at ?? 0, timer: null, fetcher }
    const run = async () => {
      const startedAt = Date.now()
      try {
        const d = await created.fetcher()
        // An older request must not overwrite a newer result (an entry that was dropped and made again).
        if ((lastKnown.get(key)?.at ?? 0) > startedAt) return
        created.data = d
        created.at = Date.now()
        keep(key, d, created.at)
        if (entries.get(key) === created) created.listeners.forEach((l) => l(d))
      } catch (err) {
        console.warn(`[poll ${key.slice(0, 40)}] failed:`, err)
        if (entries.get(key) === created) created.errorListeners.forEach((l) => l(err))
      }
    }
    entries.set(key, created as Entry<unknown>)
    e = created
    // Next request one interval after the last result, however long ago the last subscriber left.
    const wait = Math.max(0, intervalMs - (Date.now() - created.at))
    if (wait === 0) void run()
    created.timer = setTimeout(() => {
      void run()
      created.timer = setInterval(() => { void run() }, intervalMs)
    }, wait === 0 ? intervalMs : wait)
  }
  e.fetcher = fetcher
  e.listeners.add(onData)
  if (onError) e.errorListeners.add(onError)
  if (e.data !== undefined) onData(e.data)
  return () => {
    const cur = entries.get(key) as Entry<T> | undefined
    if (!cur) return
    cur.listeners.delete(onData)
    if (onError) cur.errorListeners.delete(onError)
    if (cur.listeners.size === 0) {
      // clearInterval also clears a timeout (one id space), so this covers both phases.
      if (cur.timer) clearInterval(cur.timer as ReturnType<typeof setInterval>)
      entries.delete(key)
    }
  }
}
