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
 * Location.watchPositionAsync — this is the single source of truth for position
 * updates. The request follows the pilot's situation (gpsPolicy): the
 * background task with its foreground service runs only while flying; on the
 * ground a cheaper foreground watch is used.
 */

import { PermissionsAndroid, Platform } from 'react-native'
import * as Location from 'expo-location'
import * as TaskManager from 'expo-task-manager'
import type { GpsRequestSpec } from '@open-vfr/shared/gpsPolicy'

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

/**
 * What is currently running: the background task (foreground service) or a
 * foreground-only watch, and the request it was started with. Switching tier
 * (see @open-vfr/shared/gpsPolicy) stops one and starts the other, so the
 * foreground service and its "tracking flight" notification exist only while
 * flying.
 */
// Tier changes can arrive faster than the native calls finish (a fix every second,
// each re-checking the tier): run them one at a time, in order.
let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => {})
  return next
}

let current: { key: string; watch: Location.LocationSubscription | null } | null = null

const ACCURACY: Record<GpsRequestSpec['accuracy'], Location.Accuracy> = {
  best:     Location.Accuracy.BestForNavigation,
  balanced: Location.Accuracy.Balanced,
}

async function ensurePermissions(withNotification: boolean): Promise<boolean> {
  // Foreground ("while using the app") permission only. Gate the request on
  // the current status: once answered, a repeat request can't show a dialog
  // and only returns the settled status (or, on some Android versions,
  // redirects to the Settings screen), which is jarring on every launch.
  let fg = await Location.getForegroundPermissionsAsync()
  if (fg.status === 'undetermined') fg = await Location.requestForegroundPermissionsAsync()
  if (fg.status !== 'granted') return false

  // Android 13+: the foreground service's notification is hidden (and the
  // service invisible to the pilot) unless POST_NOTIFICATIONS is granted, and
  // the system does not prompt for it on its own. Ask once; a refusal only
  // hides the notification, tracking still works. Only the flight tier has a
  // service, so only then.
  if (withNotification && Platform.OS === 'android' && Number(Platform.Version) >= 33) {
    await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS').catch(() => {})
  }
  return true
}

async function stopCurrent(): Promise<void> {
  const c = current
  current = null
  if (c?.watch) c.watch.remove()
  const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false)
  if (running) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => {})
}

/**
 * Ask the device for positions as `spec` says; a no-op when that is already
 * what is running. Background ("all the time") permission is deliberately NOT
 * requested: continuous tracking with the screen locked comes from the
 * foreground service on Android (expo-location only requires background
 * permission when no foreground service is used) and from
 * UIBackgroundModes: location on iOS, both started while the app is in use.
 * Since Android 11 a background request can't show a dialog at all -- it sends
 * the pilot to the system Location permission screen, right after they
 * approved the normal dialog. app.json also blocks ACCESS_BACKGROUND_LOCATION
 * from the manifest, which Google Play would otherwise require a separate
 * background-location declaration for.
 */
export function setLocationRequest(spec: GpsRequestSpec): Promise<'ok' | 'foreground-denied'> {
  return serial(() => applyRequest(spec))
}

async function applyRequest(spec: GpsRequestSpec): Promise<'ok' | 'foreground-denied'> {
  const key = JSON.stringify(spec)
  if (current?.key === key) return 'ok'
  if (!(await ensurePermissions(spec.foregroundService))) return 'foreground-denied'
  await stopCurrent()

  if (spec.foregroundService) {
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy:         ACCURACY[spec.accuracy],
      timeInterval:     spec.timeIntervalMs,
      distanceInterval: spec.distanceIntervalM,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'OpenVFR — tracking flight',
        notificationBody:  'GPS tracking continues while the app is in the background.',
      },
    })
    current = { key, watch: null }
  } else {
    const watch = await Location.watchPositionAsync(
      {
        accuracy:         ACCURACY[spec.accuracy],
        timeInterval:     spec.timeIntervalMs,
        distanceInterval: spec.distanceIntervalM,
      },
      (loc) => { for (const cb of listeners) cb(loc) },
    )
    current = { key, watch }
  }
  return 'ok'
}

export function stopBackgroundLocation(): Promise<void> {
  return serial(() => stopCurrent())
}
