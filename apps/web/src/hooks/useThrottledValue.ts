import { useEffect, useRef, useState } from 'react'

/** Returns `value`, but updates at most once per `ms` (trailing edge kept, so the
 *  latest value always lands). For slow-moving displays fed by a fast source. */
export function useThrottledValue<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value)
  const lastRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const latestRef = useRef(value)
  latestRef.current = value

  useEffect(() => {
    const now = performance.now()
    const wait = lastRef.current + ms - now
    if (wait <= 0) {
      lastRef.current = now
      setOut(value)
    } else if (timerRef.current === null) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        lastRef.current = performance.now()
        setOut(latestRef.current)
      }, wait)
    }
  }, [value, ms])

  useEffect(() => () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current) }, [])
  return out
}
