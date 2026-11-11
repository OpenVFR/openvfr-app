import { useEffect, useState } from 'react'

/** The current minute since the epoch; re-renders only when it changes, and not while the page is hidden. */
export function useMinuteTick(): number {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000))
  useEffect(() => {
    const update = () => setMinute(Math.floor(Date.now() / 60_000))
    let id: ReturnType<typeof setInterval> | null = null
    const start = () => { if (id === null) { update(); id = setInterval(update, 15_000) } }
    const stop = () => { if (id !== null) { clearInterval(id); id = null } }
    const onVis = () => (document.hidden ? stop() : start())
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVis)
    return () => { stop(); document.removeEventListener('visibilitychange', onVis) }
  }, [])
  return minute
}
