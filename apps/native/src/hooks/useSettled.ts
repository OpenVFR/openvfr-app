import { useEffect, useState } from 'react'

/**
 * Value that follows `value` only after it has been unchanged for `ms`.
 * For heavy derived work (airspace profile, MSA) that must not rerun on every
 * step of a leg drag or undo/redo.
 */
export function useSettled<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** Route stillness the heavy route analyses wait for, in ms. */
export const ROUTE_SETTLE_MS = 700
