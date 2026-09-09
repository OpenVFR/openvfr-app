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

export async function startBackgroundLocation(): Promise<'ok' | 'foreground-denied' | 'background-denied'> {
  const fg = await Location.requestForegroundPermissionsAsync()
  if (fg.status !== 'granted') return 'foreground-denied'

  // Background permission is only meaningful on Android/iOS when the app is
  // actually backgrounded; requesting it is best-effort — some OEM Android
  // builds and iOS "While Using" restrictions mean this can come back denied
  // even though foreground tracking still works fine. We still proceed with
  // startLocationUpdatesAsync (foreground use continues to work either way);
  // only truly suspends in background without it.
  await Location.requestBackgroundPermissionsAsync().catch(() => null)

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
