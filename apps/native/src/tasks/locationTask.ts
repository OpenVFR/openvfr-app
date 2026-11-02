/**
 * locationTask -- GPS tracking that keeps running with the screen locked or the
 * app in the background, on expo-location's `next` API (Expo SDK 58).
 *
 * Android: a foreground watcher (`watchPosition`, AIRBORNE profile: high
 * accuracy, 1 s) plus a background session (a foreground service with a
 * notification). The session keeps the watcher unthrottled in the background
 * and needs only the foreground ("while using") permission. The separate
 * "all the time" permission is deliberately never requested (see below).
 *
 * iOS: a `LocationUpdatesHandle` delivering to a task defined at module scope
 * (UIBackgroundModes: location). It runs through a CLBackgroundActivitySession
 * (the blue status-bar pill) and needs only "while using" permission.
 *
 * The AIRBORNE profile maps to CoreLocation's `.airborne` live configuration on
 * iOS, which suits a moving aircraft better than the generic navigation modes.
 *
 * The task MUST be defined at module scope, unconditionally, before the app
 * renders (imported once from index.js), so the OS can relaunch it headlessly.
 *
 * Consumers subscribe with addLocationListener(); the fix is the `next`
 * `Position`: `altitude` is ellipsoidal on both platforms and `mslAltitude` is
 * the OS's sea-level height when it has one -- see @open-vfr/shared/gpsAltitude.
 *
 * What is running follows the pilot's situation (@open-vfr/shared/gpsPolicy):
 * the background session / handle with its foreground service only while
 * flying; on the ground a cheaper foreground watch. The `next` API chooses
 * accuracy and rate by LocationProfile (no free-form interval), so the tiers
 * map to profiles: best = AIRBORNE, balanced = DEFAULT.
 */

import { Platform } from 'react-native'
import type { GpsRequestSpec } from '@open-vfr/shared/gpsPolicy'
import * as LegacyLocation from 'expo-location'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  Location, LocationProfile, LocationUpdatesHandle, PositionWatchHandle, defineLocationTask, type Position,
} from 'expo-location/next'

export const LOCATION_TASK_NAME = 'ovfr-background-location'

type Listener = (position: Position) => void
const listeners = new Set<Listener>()

export function addLocationListener(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

type ErrorListener = (message: string) => void
const errorListeners = new Set<ErrorListener>()

/** Called when the Android watcher reports an error (provider off, watcher died).
 *  Fixes resume on their own when the provider comes back. */
export function addLocationErrorListener(cb: ErrorListener): () => void {
  errorListeners.add(cb)
  return () => errorListeners.delete(cb)
}

function dispatch(position: Position): void {
  if (!position?.coordinates) return  // stale classic-API payload
  for (const cb of listeners) cb(position)
}

// iOS delivery (and any headless relaunch). Safe to evaluate more than once.
defineLocationTask({ taskName: LOCATION_TASK_NAME, onPosition: dispatch })

const ANDROID_NOTIFICATION = {
  notificationTitle: 'OpenVFR \u2014 tracking flight',
  notificationBody:  'GPS tracking continues while the app is in the background.',
}

// Startup cleanup, awaited before anything starts. Tracking never outlives the
// process on purpose (it stops when the pilot ends the flight), but the system
// keeps registrations and persisted options across a process death:
//  - Android: expo-location restarts the background session (foreground
//    service + "tracking flight" notification) from its persisted options each
//    time the app comes to the foreground, with no watcher behind it.
//  - iOS: a LocationUpdatesHandle registration survives and keeps the
//    background-location indicator on.
// Nothing has started yet when this runs, so stop whatever is left.
const orphanCleanup = (async () => {
  try {
    if (Platform.OS === 'android') {
      await Location.stopBackgroundSession()
    } else {
      const h = new LocationUpdatesHandle(LOCATION_TASK_NAME)
      if (await h.hasStarted()) await h.stop()
    }
  } catch { /* nothing registered / unavailable */ }
})()

// Migration from the classic API (SDK 57 and older, so installs updating to app
// 0.3.0): its background task registration (Android: with its own foreground
// service and notification) survives an app update and is restored at launch,
// delivering the OLD payload shape ({ locations }) to the task defined above.
// The `next` handle cannot see or stop it (it only knows its own consumer), so
// unregister it with the classic API, once per install (flag in AsyncStorage).
// Delete this block, the flag and the `expo-location` classic import once 0.3.0
// is no longer the oldest build in use (plan: remove in 0.5.0).
const LEGACY_FLAG = 'ovfr.legacyLocationTaskCleared'
const legacyCleanup: Promise<void> = (async () => {
  try {
    if (await AsyncStorage.getItem(LEGACY_FLAG)) return
    if (await LegacyLocation.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) {
      await LegacyLocation.stopLocationUpdatesAsync(LOCATION_TASK_NAME)
    }
    await AsyncStorage.setItem(LEGACY_FLAG, '1')
  } catch { /* not registered / unavailable: try again next launch */ }
})()

// What is currently running, and the request it was started with. Switching
// tier stops one and starts the other, so the foreground service and its
// "tracking flight" notification exist only while flying.
// Tier changes can arrive faster than the native calls finish (a fix every
// second, each re-checking the tier): run them one at a time, in order. A stop
// issued while a request is starting therefore waits for it and then tears it
// down, instead of being dropped.
let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => {})
  return next
}

let current: { key: string; background: boolean } | null = null
let watcher: PositionWatchHandle | null = null
let handle: LocationUpdatesHandle | null = null

const PROFILE: Record<GpsRequestSpec['accuracy'], LocationProfile> = {
  best:     LocationProfile.AIRBORNE,
  balanced: LocationProfile.DEFAULT,
}

async function ensurePermissions(withNotification: boolean): Promise<boolean> {
  // Foreground ("while using the app") permission only. Gate the request on
  // the current status: once answered, a repeat request can't show a dialog
  // and only returns the settled status (or, on some Android versions,
  // redirects to the Settings screen), which is jarring on every launch.
  let fg = await Location.getForegroundPermissions()
  if (fg.status === 'undetermined') fg = await Location.requestForegroundPermissions()
  if (!fg.granted) return false

  // Android 13+: the foreground service's notification is hidden (and the
  // service invisible to the pilot) unless POST_NOTIFICATIONS is granted, and
  // the system does not prompt for it on its own. Ask once; a refusal only
  // hides the notification, tracking still works. Only the flight tier has a
  // service, so only then.
  if (withNotification && Platform.OS === 'android') {
    const n = await Location.getNotificationPermissions().catch(() => null)
    if (n && n.status === 'undetermined') await Location.requestNotificationPermissions().catch(() => {})
  }
  return true
}

async function stopCurrent(): Promise<void> {
  const c = current
  current = null
  watcher?.dispose()
  watcher = null
  if (!c?.background) return
  if (Platform.OS === 'android') await Location.stopBackgroundSession().catch(() => {})
  else await handle?.stop().catch(() => {})
}

/**
 * Ask the device for positions as `spec` says; a no-op when that is already
 * what is running. Background ("all the time") permission is deliberately NOT
 * requested: continuous tracking with the screen locked comes from the
 * foreground service on Android and from UIBackgroundModes: location on iOS,
 * both started while the app is in use. Since Android 11 a background request
 * can't show a dialog at all -- it sends the pilot to the system Location
 * permission screen, right after they approved the normal dialog. app.json
 * also blocks ACCESS_BACKGROUND_LOCATION from the manifest, which Google Play
 * would otherwise require a separate background-location declaration for.
 */
export function setLocationRequest(spec: GpsRequestSpec): Promise<'ok' | 'foreground-denied' | 'unavailable'> {
  return serial(() => applyRequest(spec))
}

async function applyRequest(spec: GpsRequestSpec): Promise<'ok' | 'foreground-denied' | 'unavailable'> {
  const key = JSON.stringify(spec)
  if (current?.key === key) return 'ok'
  if (!(await ensurePermissions(spec.foregroundService))) return 'foreground-denied'
  await Promise.all([orphanCleanup, legacyCleanup])
  await stopCurrent()

  const profile = PROFILE[spec.accuracy]
  try {
    if (Platform.OS === 'android') {
      watcher = Location.watchPosition({
        profile,
        onPosition: dispatch,
        onError: (e) => {
          console.warn('[location] watch error', e.code, e.message)
          for (const cb of errorListeners) cb(e.message)
        },
      })
      if (spec.foregroundService) {
        // Rejects when called from the background; the options persist and the
        // service starts the next time the app is in the foreground.
        await Location.ensureBackgroundSessionStarted(ANDROID_NOTIFICATION).catch((e) => {
          console.warn('[location] background session not started:', e instanceof Error ? e.message : e)
        })
      }
    } else if (spec.foregroundService) {
      handle = new LocationUpdatesHandle(LOCATION_TASK_NAME).withProfile(profile)
      // A registration left over from a previous process survives in the system;
      // restart it so the profile and background session are fresh.
      if (await handle.hasStarted().catch(() => false)) await handle.stop().catch(() => {})
      await handle.start()
    } else {
      watcher = Location.watchPosition({
        profile,
        onPosition: dispatch,
        onError: (e) => console.warn('[location] watch error', e.code, e.message),
      })
    }
  } catch (e) {
    // Location services off (iOS) or no provider able to watch (Android).
    watcher?.dispose()
    watcher = null
    console.warn('[location] could not start:', e instanceof Error ? e.message : e)
    return 'unavailable'
  }
  current = { key, background: spec.foregroundService }
  return 'ok'
}

export function stopBackgroundLocation(): Promise<void> {
  return serial(() => stopCurrent())
}
