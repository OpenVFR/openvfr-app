/**
 * Force-update gate.
 *
 * Checked on launch and whenever the app returns to the foreground. Two
 * signals:
 *
 *  1. Our own backend (`GET /api/version`, apps/api/src/appVersion.ts): the
 *     lowest build still allowed per platform (`minBuild`, set from the admin
 *     dashboard) and the legacy semver floor (`minVersion`). Below either,
 *     the update is REQUIRED: the app shows a blocking page (UpdateRequired)
 *     until it is updated. Build numbers (Android versionCode, iOS
 *     CFBundleVersion) rise with every store build, while the version name
 *     may stay the same across releases, so they are what tells builds apart.
 *  2. The store (sp-react-native-in-app-updates: Play Core on Android, the
 *     iTunes lookup on iOS): a newer build is published. Only a nudge,
 *     shown once per launch and dismissible.
 *
 * Required update, per platform:
 *  - Android has a built-in mechanism, Play's immediate in-app update (full-
 *    screen download + install). It is offered first. It only works for a
 *    Play install with a newer build on Play, and the back button closes it,
 *    so the blocking page stays underneath either way.
 *  - iOS has no such mechanism; the blocking page with a button to the App
 *    Store is the usual way.
 *
 * Fails open: offline, or the api unreachable, the app keeps working (an
 * electronic flight bag must never lock itself on a bad connection), and the
 * answer is not cached. For the same reason a NEW block is never imposed
 * while the device is moving at flying speed; it waits for the next check on
 * the ground. A block already shown stays until the app is updated.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Linking, Platform } from 'react-native'
import * as Application from 'expo-application'
import * as Location from 'expo-location'
import SpInAppUpdates, { IAUUpdateKind } from 'sp-react-native-in-app-updates'
import { API_BASE } from '../config'

/** Minimal `major.minor.patch` comparator (app.json's `version` is a plain triplet). */
export function isOlder(current: string, minimum: string): boolean {
  const c = current.split('.').map((n) => parseInt(n, 10) || 0)
  const m = minimum.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((c[i] ?? 0) < (m[i] ?? 0)) return true
    if ((c[i] ?? 0) > (m[i] ?? 0)) return false
  }
  return false
}

/** Above this ground speed (m/s, ~30 kt) the device is taken to be flying. */
const FLYING_SPEED_MS = 15
/** A last-known fix older than this says nothing about now. */
const FIX_MAX_AGE_MS = 2 * 60_000
/** Do not re-check more often than this on quick foreground switches. */
const MIN_CHECK_INTERVAL_MS = 60_000

const platform = Platform.OS === 'android' || Platform.OS === 'ios' ? Platform.OS : null
const curVersion = Application.nativeApplicationVersion ?? '0.0.0'
/** Own build number; null when unknown (then only minVersion applies). */
const curBuild = (() => {
  const n = parseInt(Application.nativeBuildVersion ?? '', 10)
  return Number.isFinite(n) ? n : null
})()

type VersionInfo = { minVersion: string; minBuild: number }

async function fetchRequirements(): Promise<VersionInfo | null> {
  try {
    const q = platform && curBuild !== null ? `?platform=${platform}&build=${curBuild}` : ''
    const res = await fetch(`${API_BASE}/api/version${q}`)
    if (!res.ok) return null
    const body = (await res.json()) as { minVersion?: unknown; minBuild?: Record<string, unknown> }
    const raw = platform ? body.minBuild?.[platform] : undefined
    return {
      minVersion: typeof body.minVersion === 'string' ? body.minVersion : '0.0.0',
      minBuild: typeof raw === 'number' && Number.isFinite(raw) ? raw : 0,
    }
  } catch {
    return null  // offline / api down: fail open
  }
}

export function isUpdateRequired(info: VersionInfo, build: number | null = curBuild, version: string = curVersion): boolean {
  return (build !== null && build < info.minBuild) || isOlder(version, info.minVersion)
}

/** True when the last known position says the device is moving at flying speed. */
async function probablyFlying(): Promise<boolean> {
  try {
    const fix = await Location.getLastKnownPositionAsync({ maxAge: FIX_MAX_AGE_MS })
    return (fix?.coords.speed ?? 0) > FLYING_SPEED_MS
  } catch {
    return false  // no permission / no fix
  }
}

/** Play's immediate update. Resolves false when Play cannot offer it (not a Play install, no newer build, ...). */
async function startPlayImmediateUpdate(): Promise<boolean> {
  if (Platform.OS !== 'android') return false
  try {
    await new SpInAppUpdates(false).startUpdate({ updateType: IAUUpdateKind.IMMEDIATE })
    return true
  } catch {
    return false
  }
}

/** This app's store page. iOS: looked up by bundle id (no App Store id is configured). */
async function storeUrl(): Promise<string | null> {
  const id = Application.applicationId
  if (!id) return null
  if (Platform.OS === 'android') return `market://details?id=${id}`
  if (Platform.OS === 'ios') {
    try {
      const res = await fetch(`https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(id)}`)
      const body = (await res.json()) as { results?: { trackViewUrl?: string }[] }
      const url = body.results?.[0]?.trackViewUrl
      if (url) return url.replace(/^https:/, 'itms-apps:')
    } catch { /* fall through */ }
  }
  return null
}

/** Open the update: Play's immediate flow, else the store page. False when neither could be opened. */
export async function openUpdate(): Promise<boolean> {
  if (await startPlayImmediateUpdate()) return true
  const url = await storeUrl()
  if (url) {
    try { await Linking.openURL(url); return true } catch { /* below */ }
  }
  if (Platform.OS === 'android' && Application.applicationId) {
    try { await Linking.openURL(`https://play.google.com/store/apps/details?id=${Application.applicationId}`); return true } catch { /* none */ }
  }
  return false
}

/** Store nudge for an optional update (once per launch, dismissible). */
async function offerOptionalUpdate(): Promise<void> {
  try {
    const iau = new SpInAppUpdates(false)
    // Android: Play reports its newest versionCode, so compare build numbers.
    // iOS: the App Store lookup reports the version name.
    const cur = Platform.OS === 'android' && curBuild !== null ? String(curBuild) : curVersion
    const r = await iau.checkNeedsUpdate({ curVersion: cur })
    if (!r.shouldUpdate) return
    await iau.startUpdate(Platform.select({
      android: { updateType: IAUUpdateKind.FLEXIBLE },
      ios: { forceUpgrade: false },
      default: {},
    }) as any)
  } catch { /* cancelled / no store / offline: try again next launch */ }
}

export function useForceUpdate(): { required: boolean; openUpdate: () => Promise<boolean> } {
  const [required, setRequired] = useState(false)
  const requiredRef = useRef(false)
  const lastCheck = useRef(0)
  const nudged = useRef(false)
  const playOffered = useRef(false)

  const check = useCallback(async () => {
    if (Date.now() - lastCheck.current < MIN_CHECK_INTERVAL_MS) return
    lastCheck.current = Date.now()
    const info = await fetchRequirements()
    if (!info) return
    const need = isUpdateRequired(info)
    if (need && !requiredRef.current && await probablyFlying()) {
      // Allow the next foreground check (on the ground) to impose it.
      lastCheck.current = 0
      return
    }
    requiredRef.current = need
    setRequired(need)
    if (need) {
      // Built-in flow first on Android, once per launch (the page's button offers it again).
      if (!playOffered.current) { playOffered.current = true; void startPlayImmediateUpdate() }
    } else if (!nudged.current) {
      nudged.current = true
      void offerOptionalUpdate()
    }
  }, [])

  useEffect(() => {
    void check()
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') void check() })
    return () => sub.remove()
  }, [check])

  return { required, openUpdate }
}
