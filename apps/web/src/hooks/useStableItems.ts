/**
 * useStableItems — debounce for the alert stack (see @open-vfr/shared/alertStability).
 * Items appear only after their condition held for a moment and linger briefly
 * once it ends, so cards do not flicker in and out at the edge of a trigger area.
 * Re-renders on a 500 ms timer only while something is pending or lingering.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { stabilize, type StableEntry, type StableTiming } from '@open-vfr/shared/alertStability'

const TICK_MS = 500

export function useStableItems<T extends { key: string } & StableTiming>(items: readonly T[]): {
  visible: T[]
  /** Drop an item at once (user dismissed it), skipping the minimum display time. */
  forget: (key: string) => void
} {
  const entriesRef = useRef<Map<string, StableEntry<T>>>(new Map())
  const [, setTick] = useState(0)
  const result = stabilize(entriesRef.current, items, Date.now())
  entriesRef.current = result.entries

  useEffect(() => {
    if (!result.needsTick) return
    const id = setInterval(() => setTick(t => t + 1), TICK_MS)
    return () => clearInterval(id)
  }, [result.needsTick])

  const forget = useCallback((key: string) => {
    entriesRef.current.delete(key)
    setTick(t => t + 1)
  }, [])

  return { visible: result.visible, forget }
}
