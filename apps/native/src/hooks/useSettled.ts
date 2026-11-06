import { useEffect, useState } from 'react'

/**
 * Value that follows `value` only after it has been unchanged for `ms`.
 * For heavy derived work (airspace profile, MSA) that must not rerun on every
 * step of a leg drag or undo/redo.
 *
 * `hold`: keep the current value and ignore changes (e.g. while the screen is
 * not in front). Work already done is kept; the change is picked up, settled,
 * once `hold` ends.
 */
export function useSettled<T>(value: T, ms: number, hold = false): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    if (hold) return
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms, hold])
  return v
}

export { ROUTE_SETTLE_MS } from '@open-vfr/shared/routeSettle'
