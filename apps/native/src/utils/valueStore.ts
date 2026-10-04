/**
 * Minimal observable value for high-frequency UI state that only one small
 * component needs to render.
 *
 * Holding such a value in a screen's useState re-renders the whole screen on
 * every change. Example: the vertical-profile scrub position drives a single
 * marker on the map, but as MapScreen state each update re-rendered MapScreen,
 * AviationMap and the profile (~250 ms per update in a dev build). With a
 * store, the producer calls set() and only the subscribing component
 * re-renders.
 */
import { useSyncExternalStore } from 'react'

export interface ValueStore<T> {
  get(): T
  set(value: T): void
  subscribe(listener: () => void): () => void
}

export function createValueStore<T>(initial: T): ValueStore<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return
      value = next
      listeners.forEach((l) => l())
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export function useStoreValue<T>(store: ValueStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
