import { useRef } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import css from './UpdatePrompt.module.css'
import { IconX } from '@tabler/icons-react'

// How often to poll for a new service worker when the app is open.
// Installed Android PWAs are often resumed from memory rather than cold-started,
// so the browser's built-in SW update check (which fires on navigation) never
// runs. A periodic registration.update() call is the only reliable trigger.
const SW_POLL_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

/**
 * Shows a non-intrusive toast at the bottom of the screen when a new version
 * of the app is available. The user can choose to update immediately or dismiss
 * and update on the next manual reload.
 *
 * Requires registerType: 'prompt' in vite.config.ts (VitePWA).
 */
export default function UpdatePrompt() {
  const regRef = useRef<ServiceWorkerRegistration | undefined>(undefined)
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return
      regRef.current = registration
      // Immediately check for an update on mount (catches the case where a new
      // SW installed while the app was backgrounded / suspended).
      registration.update().catch(err => console.warn('[sw] update check failed', err))
      // Then poll periodically so long-lived sessions and resumed PWAs catch
      // new deployments without requiring a manual reload.
      const id = setInterval(() => { registration.update().catch(err => console.warn('[sw] update check failed', err)) }, SW_POLL_INTERVAL_MS)
      // BUG FIX: also check on tab visibility change, not just mount + the
      // hourly poll. Found live: a real deploy went out, but the toast never
      // appeared across several attempts -- the most common real-world
      // trigger for "did something change while I wasn't looking" is
      // switching back to an already-open tab (backgrounded during a
      // deploy, or the exact repeated-refresh case that can each interrupt
      // the previous check before it completes), and that had no explicit
      // trigger here at all before now.
      const onVisible = () => { if (document.visibilityState === 'visible') registration.update().catch(err => console.warn('[sw] update check failed', err)) }
      document.addEventListener('visibilitychange', onVisible)
      // No cleanup needed — this component lives for the app lifetime.
      return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible) }
    },
  })

  // BUG FIX: updateServiceWorker(true) only reloads when workbox-window's
  // 'controlling' event fires, which silently never happens in some states
  // (worker left waiting by an earlier visit, lost message, ...): the button
  // then looked dead. Drive the swap ourselves and always end in a reload.
  function applyUpdate() {
    let done = false
    const reload = () => { if (!done) { done = true; window.location.reload() } }
    navigator.serviceWorker?.addEventListener('controllerchange', reload, { once: true })
    const waiting = regRef.current?.waiting
    if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' })
    else void updateServiceWorker(true).catch(() => {})
    // Fallback: no controllerchange within 1.5 s. Drop the stale worker so the
    // reload comes from the network, and re-registers the new one.
    setTimeout(() => {
      const reg = regRef.current
      if (!reg) return reload()
      reg.unregister().catch(() => false).finally(reload)
    }, 1500)
  }

  if (!needRefresh) return null

  return (
    <div className={css.toast} role="status" aria-live="polite">
      <span className={css.message}>App update available</span>
      <button
        className={css.updateBtn}
        onClick={applyUpdate}
      >
        Reload
      </button>
      <button
        className={css.dismissBtn}
        onClick={() => setNeedRefresh(false)}
        aria-label="Dismiss update notification"
      >
        <IconX size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
