/**
 * Tab navigator — three tabs: Map | Plan | Settings.
 * Icon-only, collapsible bar: see CollapsibleTabBar.tsx.
 */

import React from 'react'
import { NavigationContainer } from '@react-navigation/native'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'

import { MapScreen }      from '../screens/MapScreen'
import { PlanScreen }     from '../screens/PlanScreen'
import { SettingsScreen } from '../screens/SettingsScreen'
import { CollapsibleTabBar } from './CollapsibleTabBar'
import { TabBarProvider } from '../context/TabBarContext'

type TabParamList = {
  Map:      undefined
  Plan:     undefined
  Settings: undefined
}

const Tab = createBottomTabNavigator<TabParamList>()

export function AppNavigator() {
  return (
    <TabBarProvider>
      <NavigationContainer>
        <Tab.Navigator
          tabBar={props => <CollapsibleTabBar {...props} />}
          screenOptions={{ headerShown: false }}
        >
          {/* Test IDs for UI automation (.maestro/screenshots.yaml): on iOS the
              tab's accessibility label is "<label>, tab, N of M", so matching
              by visible label text only works on Android. */}
          <Tab.Screen name="Map"      component={MapScreen}      options={{ tabBarButtonTestID: 'tab-map' }} />
          <Tab.Screen name="Plan"     component={PlanScreen}     options={{ tabBarLabel: 'Flight Plan', tabBarButtonTestID: 'tab-plan' }} />
          <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarButtonTestID: 'tab-settings' }} />
        </Tab.Navigator>
      </NavigationContainer>
    </TabBarProvider>
  )
}
