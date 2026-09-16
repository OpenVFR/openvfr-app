/**
 * App root — sets up SafeAreaProvider and the navigation tree.
 */

import React from 'react'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { View, ActivityIndicator, Text } from 'react-native'

class ErrorBoundary extends React.Component<{children: React.ReactNode}, {error: string|null}> {
  state = { error: null }
  componentDidCatch(e: Error) { this.setState({ error: e.message + '\n' + (e as any).componentStack }) }
  render() {
    if (this.state.error) return <View style={{flex:1,padding:16,backgroundColor:'#0a0e16'}}><Text style={{color:'#ff6b6b',fontSize:11}}>{this.state.error}</Text></View>
    return this.props.children
  }
}

import { AuthProvider, useAuthContext } from './context/AuthContext'
import { SettingsProvider }             from './context/SettingsContext'
import { RouteProvider }               from './context/RouteContext'
import { UserWaypointProvider }        from './context/UserWaypointContext'
import { FlightLogViewProvider }       from './context/FlightLogViewContext'
import { SimProvider }                 from './context/SimContext'
import { VarioProvider }               from './context/VarioContext'
import { AppNavigator }  from './navigation'
import { LoginScreen }   from './screens/LoginScreen'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from './styles/theme'
import { useForceUpdate } from './hooks/useForceUpdate'

function AppShell() {
  const styles = useThemedStyles(makeStyles)
  const { state } = useAuthContext()

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        {state.status === 'loading' && (
          <View style={styles.splash}>
            <ActivityIndicator color={theme.accentBlue} size="large" />
          </View>
        )}
        {state.status === 'unauthenticated' && <LoginScreen />}
        {state.status === 'authenticated'   && <AppNavigator />}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

export default function App() {
  // Fires on every cold launch, before anything else renders -- if the
  // running build is below the backend's supported floor, this triggers a
  // blocking platform update flow (see useForceUpdate.ts's header comment).
  useForceUpdate()

  return (
    <ErrorBoundary>
      <KeyboardProvider>
      <AuthProvider>
        <SettingsProvider>
          <RouteProvider>
            <UserWaypointProvider>
            <FlightLogViewProvider>
            <SimProvider>
              <VarioProvider>
                <AppShell />
              </VarioProvider>
            </SimProvider>
            </FlightLogViewProvider>
            </UserWaypointProvider>
          </RouteProvider>
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
