import { useRef } from 'react'

/**
 * Returns `props` with every function value replaced by a referentially
 * stable wrapper that always calls the latest function. Lets a `memo`'d
 * child skip re-renders caused only by inline arrow functions, without
 * stale closures. Non-function values pass through unchanged (so changing
 * data still re-renders). A function prop that is temporarily undefined is
 * passed as undefined.
 */
export function useStableProps<P extends Record<string, unknown>>(props: P): P {
  const latest = useRef<P>(props)
  latest.current = props
  const wrappers = useRef<Record<string, (...a: unknown[]) => unknown>>({})
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(props)) {
    const v = props[k]
    if (typeof v === 'function') {
      wrappers.current[k] ??= (...a: unknown[]) => (latest.current[k] as ((...x: unknown[]) => unknown) | undefined)?.(...a)
      out[k] = wrappers.current[k]
    } else {
      out[k] = v
    }
  }
  return out as P
}
