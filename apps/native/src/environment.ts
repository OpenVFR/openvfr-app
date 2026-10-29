/**
 * Backend environment selection: the default backend, or an optional second
 * ("staging") backend configured at build time (EXPO_PUBLIC_STAGING_API_BASE).
 * Builds without it always use the default backend and offer no switch.
 *
 *  - Only these two build-time backends, never a user-typed server URL.
 *  - Accounts, sessions and synced data belong to one backend, so switching
 *    signs out first and the next sign-in is against the other backend.
 *  - The choice is read synchronously when this module loads, before
 *    config.ts derives API_BASE & co., and takes effect at the next app
 *    start (restartPending() until then; sign-in is blocked meanwhile).
 *  - Downloaded tiles stay (STAGING.tileBase defaults to the same host).
 */
import { File, Paths } from 'expo-file-system'
import {
  resolveAppEnvironment, isAppEnvironmentId, appEnvironmentLabel, type AppEnvironmentId,
} from '@open-vfr/shared/appEnvironment'

export type { AppEnvironmentId }
export { appEnvironmentLabel }

const trimUrl = (v: string | undefined): string => (v ?? '').trim().replace(/\/+$/, '')

/** Staging backend, from build-time env. Empty apiBase = no staging in this build. */
export const STAGING = {
  apiBase:     trimUrl(process.env.EXPO_PUBLIC_STAGING_API_BASE),
  /** Empty = same tile host as the default backend. */
  tileBase:    trimUrl(process.env.EXPO_PUBLIC_STAGING_TILE_BASE),
  /** Empty = the staging api. */
  trafficBase: trimUrl(process.env.EXPO_PUBLIC_STAGING_TRAFFIC_BASE),
  webBase:     trimUrl(process.env.EXPO_PUBLIC_STAGING_WEB_BASE),
} as const

export const STAGING_AVAILABLE = STAGING.apiBase !== ''

/** EXPO_PUBLIC_DEFAULT_ENVIRONMENT=staging makes a build start on the second backend. */
const BUILD_DEFAULT = process.env.EXPO_PUBLIC_DEFAULT_ENVIRONMENT

// Document directory: removed with the app (unlike the iOS keychain), so a
// reinstall starts from the build's default again.
const STORE_FILE = 'environment.json'

function readSaved(): AppEnvironmentId | null {
  try {
    const f = new File(Paths.document, STORE_FILE)
    if (!f.exists) return null
    const v = (JSON.parse(f.textSync()) as { environment?: unknown }).environment
    return isAppEnvironmentId(v) ? v : null
  } catch {
    return null
  }
}

/** The environment this app process runs with (fixed until the next start). */
export const ACTIVE_ENVIRONMENT: AppEnvironmentId = resolveAppEnvironment({
  saved: readSaved(),
  buildDefault: BUILD_DEFAULT,
  stagingAvailable: STAGING_AVAILABLE,
})

// What the next start will use; changes only through saveEnvironment().
let next: AppEnvironmentId = ACTIVE_ENVIRONMENT

/** The environment the next app start will use. */
export function nextEnvironment(): AppEnvironmentId {
  return next
}

/** A switch was saved but the app hasn't restarted yet. */
export function restartPending(): boolean {
  return nextEnvironment() !== ACTIVE_ENVIRONMENT
}

const listeners = new Set<() => void>()

/** Notified after saveEnvironment() (for useSyncExternalStore). */
export function subscribeEnvironment(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Persist the choice for the next app start. Callers sign out first. */
export function saveEnvironment(id: AppEnvironmentId): void {
  if (id === 'staging' && !STAGING_AVAILABLE) throw new Error('This build has no staging environment')
  const f = new File(Paths.document, STORE_FILE)
  if (f.exists) f.delete()  // same write pattern as offlineCache.ts's sidecar
  f.write(JSON.stringify({ environment: id }))
  next = id
  listeners.forEach(l => l())
}
