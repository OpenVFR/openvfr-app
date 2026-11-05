/**
 * notamCoordinateFocus.ts -- "show this coordinate on the map", a tiny
 * publish/subscribe channel between a NOTAM detail view (anywhere in the UI)
 * and the map. The detail views call `focusNotamCoordinate()`; each map
 * subscribes once and draws a marker. Platform-neutral, no React.
 */
export interface NotamCoordinateFocus { lat: number; lng: number; /** Changes on every call, so the same point can be focused twice. */ seq: number }

type Listener = (f: NotamCoordinateFocus | null) => void

const listeners = new Set<Listener>()
let current: NotamCoordinateFocus | null = null
let seq = 0

export function focusNotamCoordinate(p: { lat: number; lng: number }): void {
  current = { lat: p.lat, lng: p.lng, seq: ++seq }
  for (const l of listeners) l(current)
}

export function clearNotamCoordinateFocus(): void {
  if (!current) return
  current = null
  for (const l of listeners) l(null)
}

export function getNotamCoordinateFocus(): NotamCoordinateFocus | null {
  return current
}

/** Returns the unsubscribe function. */
export function subscribeNotamCoordinateFocus(l: Listener): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
