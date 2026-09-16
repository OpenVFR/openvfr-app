/**
 * Tab navigator — three tabs: Map | Plan | Settings
 */

import React from 'react'
import { NavigationContainer } from '@react-navigation/native'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { Ionicons } from '@expo/vector-icons'

import { MapScreen }      from '../screens/MapScreen'
import { PlanScreen }     from '../screens/PlanScreen'
import { SettingsScreen } from '../screens/SettingsScreen'
import { theme, useScaledTheme } from '../styles/theme'

type TabParamList = {
  Map:      undefined
  Plan:     undefined
  Settings: undefined
}

const Tab = createBottomTabNavigator<TabParamList>()

type IoniconName = React.ComponentProps<typeof Ionicons>['name']

const TAB_ICONS: Record<keyof TabParamList, { active: IoniconName; inactive: IoniconName }> = {
  Map:      { active: 'map',           inactive: 'map-outline'           },
  Plan:     { active: 'navigate',      inactive: 'navigate-outline'      },
  Settings: { active: 'settings',      inactive: 'settings-outline'      },
}

export function AppNavigator() {
  const scaledTheme = useScaledTheme()
  // React Navigation's own default icon `size` doesn't know about our uiScale
  // setting -- override it explicitly so the tab bar scales with everything
  // else (this is the one screen visible in every flight phase, worth
  // reading correctly from a kneeboard/dashboard mount).
  const iconSize = scaledTheme.scale(24)
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarStyle: {
            backgroundColor: theme.surfacePanel,
            borderTopColor:  theme.borderDefault,
            borderTopWidth:  1,
            height: scaledTheme.scale(56),
            paddingBottom: scaledTheme.space1,
            paddingTop: scaledTheme.space1,
          },
          tabBarActiveTintColor:   theme.accentBlue,
          tabBarInactiveTintColor: theme.textMuted,
          tabBarLabelStyle: {
            fontSize:   scaledTheme.textXs,
            fontWeight: '600',
          },
          tabBarIcon: ({ focused, color }) => {
            const icons = TAB_ICONS[route.name as keyof TabParamList]
            return (
              <Ionicons
                name={focused ? icons.active : icons.inactive}
                size={iconSize}
                color={color}
              />
            )
          },
        })}
      >
        <Tab.Screen name="Map"      component={MapScreen}      />
        <Tab.Screen name="Plan"     component={PlanScreen}     options={{ tabBarLabel: 'Flight Plan' }} />
        <Tab.Screen name="Settings" component={SettingsScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  )
}
