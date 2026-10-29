/**
 * Production / staging switching UI (see ../environment.ts for the rules).
 *
 *  - useEnvironmentSwitch(): the hidden picker + the switch flow (sign out
 *    first when signed in, save, ask for a restart).
 *  - useEnvironmentDeepLink(): `openvfr://environment/<id>` asks to switch.
 *  - <EnvironmentBanner />: always visible while running on staging, or
 *    while a switch waits for the restart.
 */
import React, { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { Alert, DevSettings, Linking, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { parseEnvironmentLink } from '@open-vfr/shared/appEnvironment'
import {
  ACTIVE_ENVIRONMENT, STAGING_AVAILABLE, appEnvironmentLabel, nextEnvironment,
  restartPending, saveEnvironment, subscribeEnvironment, type AppEnvironmentId,
} from '../environment'
import { useAuthContext } from '../context/AuthContext'
import { flushBeforeSignOut } from '../sync/cloudSync'

/** Re-renders when a switch is saved. */
export function useNextEnvironment(): AppEnvironmentId {
  return useSyncExternalStore(subscribeEnvironment, nextEnvironment)
}

export function useRestartPending(): boolean {
  useNextEnvironment()
  return restartPending()
}

/**
 * Base URLs are read once per app start, so a switch needs a fresh start. Dev
 * builds reload the JS bundle; release builds can't restart themselves
 * without an extra native module, so the user closes and reopens the app.
 * Until then the login screen blocks sign-in and the banner says why.
 */
export function promptRestart(target: AppEnvironmentId): void {
  if (__DEV__) {
    DevSettings.reload()
    return
  }
  Alert.alert(
    'Restart OpenVFR',
    `Close OpenVFR completely (swipe it away in the app switcher) and open it again to continue on ${appEnvironmentLabel(target)}.`,
  )
}

function confirmText(target: AppEnvironmentId, signedIn: boolean): string {
  const parts = [
    signedIn
      ? `Accounts are separate per server: you will be signed out here and sign in again on ${appEnvironmentLabel(target)}. Unsynced changes are sent first.`
      : `The app connects to ${appEnvironmentLabel(target)} after a restart.`,
  ]
  if (target === 'staging') {
    parts.push('Staging is for testing. NOTAMs and other data there can be test data: never use it for flight planning.')
  }
  return parts.join('\n\n')
}

export function useEnvironmentSwitch() {
  const { state, signOut } = useAuthContext()
  const signedIn = state.status === 'authenticated'

  const doSwitch = useCallback(async (target: AppEnvironmentId) => {
    if (signedIn) {
      const flushed = await flushBeforeSignOut()
      if (!flushed) {
        const proceed = await new Promise<boolean>(resolve => Alert.alert(
          'Unsynced changes',
          'Some routes, aircraft, waypoints or flight logs on this device have not reached the cloud yet (no connection?). Switching signs you out and deletes them from this device.',
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Switch anyway', style: 'destructive', onPress: () => resolve(true) },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        ))
        if (!proceed) return
      }
      await signOut()
    }
    saveEnvironment(target)
    if (target !== ACTIVE_ENVIRONMENT) promptRestart(target)
  }, [signedIn, signOut])

  /** Ask, then switch. No-op in builds without staging. */
  const requestSwitch = useCallback((target: AppEnvironmentId) => {
    if (!STAGING_AVAILABLE) return
    if (target === nextEnvironment()) {
      if (target !== ACTIVE_ENVIRONMENT) promptRestart(target)
      else Alert.alert('Server', `Already using ${appEnvironmentLabel(target)}.`)
      return
    }
    // Back to the environment still running: nothing to sign out of or restart.
    if (target === ACTIVE_ENVIRONMENT) {
      saveEnvironment(target)
      return
    }
    Alert.alert(`Switch to ${appEnvironmentLabel(target)}?`, confirmText(target, signedIn), [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Switch', style: target === 'staging' ? 'destructive' : 'default', onPress: () => { void doSwitch(target) } },
    ])
  }, [signedIn, doSwitch])

  /** Hidden picker (Settings: Version x5, login: logo x7). */
  const openPicker = useCallback(() => {
    if (!STAGING_AVAILABLE) return
    const current = nextEnvironment()
    const option = (id: AppEnvironmentId) => ({
      text: appEnvironmentLabel(id) + (id === current ? ' \u2713' : ''),
      onPress: () => requestSwitch(id),
    })
    Alert.alert('Server', `Running on ${appEnvironmentLabel(ACTIVE_ENVIRONMENT)}.`, [
      { text: 'Cancel', style: 'cancel' },
      option('production'),
      option('staging'),
    ])
  }, [requestSwitch])

  return { available: STAGING_AVAILABLE, requestSwitch, openPicker }
}

/** `openvfr://environment/staging` | `/production`: asks before switching. */
export function useEnvironmentDeepLink(): void {
  const { requestSwitch } = useEnvironmentSwitch()
  // Latest callback in a ref: the listener (and the launch URL) must be
  // handled once, not again every time sign-in state changes the callback.
  const requestRef = useRef(requestSwitch)
  requestRef.current = requestSwitch
  useEffect(() => {
    if (!STAGING_AVAILABLE) return
    const handle = (url: string | null) => {
      const target = parseEnvironmentLink(url)
      if (target) requestRef.current(target)
    }
    Linking.getInitialURL().then(handle).catch(() => {})
    const sub = Linking.addEventListener('url', (e) => handle(e.url))
    return () => sub.remove()
  }, [])
}

/**
 * Thin strip at the top of every screen on staging (or while a switch waits
 * for the restart). Not pressable: it must never cover map controls' touches.
 */
export function EnvironmentBanner() {
  const insets = useSafeAreaInsets()
  const next = useNextEnvironment()
  const pending = next !== ACTIVE_ENVIRONMENT
  if (ACTIVE_ENVIRONMENT === 'production' && !pending) return null
  const text = pending
    ? `Restart OpenVFR to switch to ${appEnvironmentLabel(next)}`
    : 'STAGING \u00b7 test server, not for flight planning'
  return (
    <View
      pointerEvents="none"
      testID="environment-banner"
      style={{
        position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1000, elevation: 1000,
        paddingTop: insets.top, backgroundColor: pending ? '#7c2d12' : '#b45309',
      }}
    >
      <Text style={{ color: '#ffffff', fontSize: 11, fontWeight: '700', textAlign: 'center', paddingVertical: 2 }}>
        {text}
      </Text>
    </View>
  )
}
