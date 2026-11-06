import { useSyncExternalStore } from 'react'
import { AppState } from 'react-native'

const subscribe = (cb: () => void) => {
  const sub = AppState.addEventListener('change', cb)
  return () => sub.remove()
}
const snapshot = () => AppState.currentState === 'active'

/**
 * True while the app is in the foreground. Polling and timers that only feed
 * the screen (live traffic, wind, NOTAM lists) pause while it is false, so a
 * flight with the screen off, or the app in the background, does not keep the
 * radio and the CPU busy for nobody. They resume, and fetch at once, on return.
 */
export function useAppActive(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
