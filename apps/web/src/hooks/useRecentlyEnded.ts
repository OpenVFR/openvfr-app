import { useEffect, useRef, useState } from 'react'

/** True for `ms` after `active` turns from true to false (never at mount). For "just stopped" rules. */
export function useRecentlyEnded(active: boolean, ms: number): boolean {
  const [recent, setRecent] = useState(false)
  const prev = useRef(active)
  useEffect(() => {
    const was = prev.current
    prev.current = active
    if (active) { setRecent(false); return }
    if (!was) return
    setRecent(true)
    const t = setTimeout(() => setRecent(false), ms)
    return () => clearTimeout(t)
  }, [active, ms])
  return recent
}
