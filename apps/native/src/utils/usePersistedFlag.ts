import { useCallback, useEffect, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'

/** A boolean UI preference remembered on this device (AsyncStorage). Starts at `initial`, then takes the stored value. */
export function usePersistedFlag(key: string, initial: boolean): [boolean, (next: boolean | ((v: boolean) => boolean)) => void] {
  const [value, setValue] = useState<boolean>(initial)
  useEffect(() => {
    let alive = true
    AsyncStorage.getItem(key).then((v) => { if (alive && v !== null) setValue(v === '1') }).catch(() => { /* keep the default */ })
    return () => { alive = false }
  }, [key])
  const set = useCallback((next: boolean | ((v: boolean) => boolean)) => {
    setValue((prev) => {
      const v = typeof next === 'function' ? next(prev) : next
      AsyncStorage.setItem(key, v ? '1' : '0').catch(() => { /* keep in memory */ })
      return v
    })
  }, [key])
  return [value, set]
}
