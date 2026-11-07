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
  timer: ReturnType<typeof setInterval> | null
  fetcher: () => Promise<T>
}

const entries = new Map<string, Entry<unknown>>()
const lastKnown = new Map<string, { data: unknown; at: number }>()

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
      try {
        const d = await created.fetcher()
        created.data = d
        created.at = Date.now()
        lastKnown.set(key, { data: d, at: created.at })
        created.listeners.forEach((l) => l(d))
      } catch (err) {
        console.warn(`[poll ${key.slice(0, 40)}] failed:`, err)
        created.errorListeners.forEach((l) => l(err))
      }
    }
    created.timer = setInterval(() => { void run() }, intervalMs)
    entries.set(key, created as Entry<unknown>)
    e = created
    if (Date.now() - created.at >= intervalMs) void run()
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
      if (cur.timer) clearInterval(cur.timer)
      entries.delete(key)
    }
  }
}
