import { useCallback, useState } from 'react'

/** A boolean UI preference remembered in localStorage (this device only). */
export function usePersistedFlag(key: string, initial: boolean): [boolean, (next: boolean | ((v: boolean) => boolean)) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(key)
      return v === null ? initial : v === '1'
    } catch { return initial }
  })
  const set = useCallback((next: boolean | ((v: boolean) => boolean)) => {
    setValue((prev) => {
      const v = typeof next === 'function' ? next(prev) : next
      try { localStorage.setItem(key, v ? '1' : '0') } catch { /* private mode / quota: keep in memory */ }
      return v
    })
  }, [key])
  return [value, set]
}
