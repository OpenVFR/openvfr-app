/**
 * locationTask — background-capable GPS tracking via expo-task-manager +
 * expo-location's startLocationUpdatesAsync.
 *
 * Fixes: "track recording continues when screen locks" — plain
 * Location.watchPositionAsync (foreground-only) gets suspended by Android/iOS
 * power management as soon as the screen turns off or the app backgrounds.
 * startLocationUpdatesAsync + a registered TaskManager task, combined with
 * Android's foregroundService option (persistent notification), keeps the
 * OS location provider — and this app's JS process — alive continuously.
 *
 * The task MUST be defined at module scope, unconditionally, before the app
 * renders (imported once from index.js) — TaskManager requires this so the
 * task can also be re-invoked if the app is relaunched headlessly by the OS.
 *
 * Consumers subscribe via addLocationListener() instead of directly calling
 * Location.watchPositionAsync — this makes the background task the single
 * source of truth for position updates whether the app is foregrounded or not.
 */

import * as Location from 'expo-location'
import * as TaskManager from 'expo-task-manager'

export const LOCATION_TASK_NAME = 'ovfr-background-location'

type Listener = (location: Location.LocationObject) => void
const listeners = new Set<Listener>()

export function addLocationListener(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// Defined once at module load — safe to import this module multiple times,
// defineTask is idempotent (re-defining with the same name just replaces
// the executor function).
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) return
  const locations = (data as { locations?: Location.LocationObject[] } | null)?.locations
  if (!locations) return
  for (const loc of locations) {
    for (const cb of listeners) cb(loc)
  }
})

let started = false

export async function startBackgroundLocation(): Promise<'ok' | 'foreground-denied'> {
  // Foreground ("while using the app") permission only. Gate the request on
  // the current status: once answered, a repeat request can't show a dialog
  // and only returns the settled status (or, on some Android versions,
  // redirects to the Settings screen), which is jarring on every launch.
  let fg = await Location.getForegroundPermissionsAsync()
  if (fg.status === 'undetermined') fg = await Location.requestForegroundPermissionsAsync()
  if (fg.status !== 'granted') return 'foreground-denied'

  // Background ("all the time") permission is deliberately NOT requested.
  // Continuous tracking with the screen locked or the app in the background
  // comes from the foreground service below on Android (expo-location only
  // requires background permission when no foreground service is used) and
  // from UIBackgroundModes: location on iOS, both started while the app is
  // in use. Since Android 11 a background request can't show a dialog at
  // all -- it sends the pilot to the system Location permission screen,
  // right after they approved the normal dialog. app.json also blocks
  // ACCESS_BACKGROUND_LOCATION from the manifest, which Google Play would
  // otherwise require a separate background-location declaration for.

  const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false)
  if (!alreadyStarted) {
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy:         Location.Accuracy.BestForNavigation,
      timeInterval:     1_000,
      distanceInterval: 0,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'open-vfr — tracking flight',
        notificationBody:  'GPS tracking continues while the app is in the background.',
      },
    })
  }
  started = true
  return 'ok'
}

export async function stopBackgroundLocation(): Promise<void> {
  if (!started) return
  const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false)
  if (running) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME)
  started = false
}
