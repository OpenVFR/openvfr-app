/**
 * Navigation: a native stack. Map is the root (home); Plan and Settings are
 * pushed on top of it from the map tools menu (MapToolbar) and left with the
 * platform's standard back affordances -- header back button, iOS edge swipe,
 * Android system back. There is no tab bar.
 */

import React from 'react'
import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'

import { MapScreen }      from '../screens/MapScreen'
import { PlanScreen }     from '../screens/PlanScreen'
import { SettingsScreen } from '../screens/SettingsScreen'
import { theme } from '../styles/theme'

export type RootStackParamList = {
  Map:      undefined
  Plan:     undefined
  Settings: undefined
}

const Stack = createNativeStackNavigator<RootStackParamList>()

export function AppNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator
        initialRouteName="Map"
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.surfaceBase },
        }}
      >
        <Stack.Screen name="Map" component={MapScreen} />
        <Stack.Screen
          name="Plan"
          component={PlanScreen}
          options={{ ...headerOptions, title: 'Flight Plan' }}
        />
        <Stack.Screen
          name="Settings"
          component={SettingsScreen}
          options={{ ...headerOptions, title: 'Settings' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  )
}

const headerOptions = {
  headerShown: true,
  headerStyle: { backgroundColor: theme.surfacePanel },
  headerTintColor: theme.textPrimary,
  headerTitleStyle: { color: theme.textPrimary },
  headerShadowVisible: false,
  headerBackButtonDisplayMode: 'minimal' as const,
}
