/**
 * Whether a flight (GPS or simulated) is in progress, published by MapScreen
 * for screens that must lock settings in flight (e.g. the country picker:
 * changing country reloads the map screen and all its data).
 */
import { useEffect, useState } from 'react'

let active = false
const listeners = new Set<(v: boolean) => void>()

export function setFlightActive(v: boolean): void {
  if (v === active) return
  active = v
  listeners.forEach(l => l(v))
}

export function useFlightActive(): boolean {
  const [v, setV] = useState(active)
  useEffect(() => {
    setV(active)
    listeners.add(setV)
    return () => { listeners.delete(setV) }
  }, [])
  return v
}
