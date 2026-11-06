/**
 * App root — sets up SafeAreaProvider and the navigation tree.
 */

import React from 'react'
import { StatusBar } from 'expo-status-bar'
import { NavigationBar } from 'expo-navigation-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { View, ActivityIndicator, Text, Platform } from 'react-native'

// Only the store-screenshot build (eas.json "screenshots" profile) sets this:
// hide the system status and navigation bars so captures show just the app.
const SCREENSHOT_MODE = process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1'

class ErrorBoundary extends React.Component<{children: React.ReactNode}, {error: string|null}> {
  state = { error: null }
  componentDidCatch(e: Error) { this.setState({ error: e.message + '\n' + (e as any).componentStack }) }
  render() {
    if (this.state.error) return <View style={{flex:1,padding:16,backgroundColor:'#0a0e16'}}><Text style={{color:'#ff6b6b',fontSize:11}}>{this.state.error}</Text></View>
    return this.props.children
  }
}

import { AuthProvider, useAuthContext } from './context/AuthContext'
import { useCloudSyncLifecycle } from './sync/cloudSync'
import { SettingsProvider }             from './context/SettingsContext'
import { RouteProvider }               from './context/RouteContext'
import { UserWaypointProvider }        from './context/UserWaypointContext'
import { FlightLogViewProvider }       from './context/FlightLogViewContext'
import { MapFocusProvider }            from './context/MapFocusContext'
import { SimProvider }                 from './context/SimContext'
import { VarioProvider }               from './context/VarioContext'
import { AppNavigator }  from './navigation'
import { LoginScreen }   from './screens/LoginScreen'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from './styles/theme'
import { useForceUpdate } from './hooks/useForceUpdate'
import { UpdateRequired } from './components/UpdateRequired'
import { EnvironmentBanner, useEnvironmentDeepLink } from './components/EnvironmentSwitch'
import { PasskeyPromptModal } from './components/PasskeyPromptModal'
import { SystemMessages } from './components/SystemMessages'

function AppShell() {
  const styles = useThemedStyles(makeStyles)
  const { state } = useAuthContext()
  // Cloud sync of routes, aircraft, waypoints and flight logs for the
  // signed-in account (see sync/cloudSync.ts).
  useCloudSyncLifecycle(state.status === 'authenticated' ? state.user.id : null)
  // openvfr://environment/<id> -> switch production/staging (environment.ts).
  useEnvironmentDeepLink()

  React.useEffect(() => {
    if (SCREENSHOT_MODE && Platform.OS === 'android') {
      NavigationBar.setHidden(true)
    }
  }, [])

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        {/* iPhone Duo: keep the status bar horizontal at the top instead of in
            iOS's vertical rail. The map is full screen with its own control
            column; the rail pushed that column left of a large clock block.
            Apple allows opting out per screen for layouts that horizontal
            bars serve better (preferredVerticalBarBehavior); the map screen
            stays mounted under every other screen, so it applies app-wide. */}
        <StatusBar style="light" hidden={SCREENSHOT_MODE} verticalBarBehaviorIOS="disabled" />
        {state.status === 'loading' && (
          <View style={styles.splash}>
            <ActivityIndicator color={theme.accentBlue} size="large" />
          </View>
        )}
        {(state.status === 'unauthenticated' || (state.status === 'authenticated' && !state.user.name)) && <LoginScreen />}
        {state.status === 'authenticated' && !!state.user.name && <AppNavigator />}
        {state.status === 'authenticated' && !!state.user.name && <PasskeyPromptModal />}
        <SystemMessages />
        <EnvironmentBanner />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

/** Remounts the data providers per account so nothing from the previous
 *  account's in-memory state (route, waypoints, ...) survives a switch. */
function UserScoped({ children }: { children: React.ReactNode }) {
  const { state } = useAuthContext()
  const id = state.status === 'authenticated' ? state.user.id : 'anonymous'
  return <React.Fragment key={id}>{children}</React.Fragment>
}

export default function App() {
  // Checked on launch and on every return to the foreground: below the
  // server's minimum build, the blocking UpdateRequired page replaces the
  // whole app (see useForceUpdate.ts's header comment). Replaces, not
  // covers: a native map view could draw above an overlay on Android. A
  // block is never newly imposed at flying speed, so nothing in flight is
  // torn down; an open flight log is closed by the orphan recovery later.
  const forceUpdate = useForceUpdate()
  if (forceUpdate.required) return <UpdateRequired onUpdate={forceUpdate.openUpdate} />

  return (
    <ErrorBoundary>
      <KeyboardProvider>
      <AuthProvider>
        <SettingsProvider>
          <UserScoped>
          <RouteProvider>
            <UserWaypointProvider>
            <FlightLogViewProvider>
            <MapFocusProvider>
            <SimProvider>
              <VarioProvider>
                <AppShell />
              </VarioProvider>
            </SimProvider>
            </MapFocusProvider>
            </FlightLogViewProvider>
            </UserWaypointProvider>
          </RouteProvider>
          </UserScoped>
        </SettingsProvider>
      </AuthProvider>
      </KeyboardProvider>
    </ErrorBoundary>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  root: {
    flex:            1,
    backgroundColor: theme.surfaceBase,
  },
  splash: {
    flex:            1,
    justifyContent:  'center',
    alignItems:      'center',
    backgroundColor: theme.surfaceBase,
  },
} as const
}
