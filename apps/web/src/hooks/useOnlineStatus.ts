import { useEffect, useState } from 'react'

/**
 * Returns true when the browser believes it has a working internet connection.
 * Tracks the `online` / `offline` window events so the value updates reactively.
 *
 * Note: `navigator.onLine` is optimistic — it only detects network interface
 * availability, not actual server reachability. But it's sufficient for showing
 * an offline indicator and gating non-critical network calls.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)

  useEffect(() => {
    const onOnline  = () => setOnline(true)
    const onOffline = () => setOnline(false)
    window.addEventListener('online',  onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online',  onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  return online
}
