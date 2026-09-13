/**
 * Force-update gate.
 *
 * Runs once on launch. Two independent signals decide whether to prompt,
 * and how hard:
 *
 *  1. Store check (sp-react-native-in-app-updates): "is there a newer
 *     version published?" -- via Play Core on Android, the iTunes Search
 *     API on iOS. Always the platform/store-native answer, never our own
 *     server, so it works even for users on a stale build we no longer
 *     control (e.g. deploy predates a policy change).
 *  2. Our own backend (`GET /api/version` -> minVersion, see
 *     apps/api/src/index.ts): "is the running build actually broken
 *     against the current API?" This is the only signal that can turn a
 *     dismissible nudge into a mandatory block -- the store alone doesn't
 *     know which past releases are API-incompatible.
 *
 * Update UI itself is always the platform-provided flow (Play Core's
 * in-app overlay on Android, the App Store alert on iOS) -- never a
 * custom modal. See the earlier discussion: both platforms have an
 * accepted mechanism for this; rolling a bespoke blocking screen instead
 * would just be reinventing what the store already provides.
 */
import { useEffect } from 'react'
import { Platform } from 'react-native'
import * as Application from 'expo-application'
import SpInAppUpdates, { IAUUpdateKind } from 'sp-react-native-in-app-updates'
import { API_BASE } from '../config'

/** Minimal `major.minor.patch` comparator -- app.json's `version` field is
 *  always a plain semver triplet, never a pre-release/build-metadata tag,
 *  so a full semver parser would be unused complexity here. */
function isOlder(current: string, minimum: string): boolean {
  const c = current.split('.').map((n) => parseInt(n, 10) || 0)
  const m = minimum.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((c[i] ?? 0) < (m[i] ?? 0)) return true
    if ((c[i] ?? 0) > (m[i] ?? 0)) return false
  }
  return false
}

async function fetchMinVersion(): Promise<string> {
  try {
    const res = await fetch(`${API_BASE}/api/version`)
    if (!res.ok) return '0.0.0'
    const body = (await res.json()) as { minVersion?: string }
    return body.minVersion ?? '0.0.0'
  } catch {
    // Offline at launch: fail open. The check re-runs on every subsequent
    // launch/resume, so this only delays the prompt, never suppresses it
    // once connectivity is back.
    return '0.0.0'
  }
}

export function useForceUpdate(): void {
  useEffect(() => {
    let cancelled = false

    async function run() {
      const curVersion = Application.nativeApplicationVersion ?? '0.0.0'
      const [minVersion, needsUpdate] = await Promise.all([
        fetchMinVersion(),
        new SpInAppUpdates(false).checkNeedsUpdate({ curVersion }).catch(() => null),
      ])
      if (cancelled) return

      // Mandatory only when our own API says this build is below the
      // supported floor. A store update merely being *available* (the
      // library's own `shouldUpdate`) stays a soft/flexible nudge --
      // most releases aren't breaking changes and shouldn't force anyone.
      const forceMode = isOlder(curVersion, minVersion)
      if (!forceMode && !needsUpdate?.shouldUpdate) return

      const inAppUpdates = new SpInAppUpdates(false)
      try {
        await inAppUpdates.startUpdate(
          Platform.select({
            android: { updateType: forceMode ? IAUUpdateKind.IMMEDIATE : IAUUpdateKind.FLEXIBLE },
            ios: { forceUpgrade: forceMode },
            default: {},
          }) as any,
        )
      } catch {
        // User cancelled a flexible prompt, or the store call failed
        // (offline, no store account, sideloaded build, etc.) -- nothing
        // else to do; the check runs again next launch.
      }
    }

    void run()
    return () => { cancelled = true }
  }, [])
}
