/**
 * "Repair app files" -- recovery for a broken cached app shell / stale
 * cached map data: unregisters every service worker for this origin,
 * deletes every Cache Storage bucket (precached app files and the runtime
 * tile/aviation-data caches), then reloads from the network.
 *
 * Deliberately NON-destructive to user data: IndexedDB (RxDB -- routes,
 * aircraft, user waypoints, flight logs, settings) and localStorage are left
 * untouched, so unsynced local work survives. A full local-data wipe is a
 * different, destructive operation and intentionally not offered here.
 *
 * Every step is best-effort: a failure in one (e.g. Cache Storage
 * unavailable in a private window) must not prevent the reload that is the
 * whole point of a recovery action.
 */
export async function repairAppFiles(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map(r => r.unregister().catch(() => false)))
    }
  } catch { /* ignore -- still reload */ }
  try {
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map(k => caches.delete(k).catch(() => false)))
    }
  } catch { /* ignore -- still reload */ }
  window.location.reload()
}
