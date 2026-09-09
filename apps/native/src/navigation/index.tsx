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
import { theme }          from '../styles/theme'

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
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarStyle: {
            backgroundColor: theme.surfacePanel,
            borderTopColor:  theme.borderDefault,
            borderTopWidth:  1,
          },
          tabBarActiveTintColor:   theme.accentBlue,
          tabBarInactiveTintColor: theme.textMuted,
          tabBarLabelStyle: {
            fontSize:   10,
            fontWeight: '600',
          },
          tabBarIcon: ({ focused, color, size }) => {
            const icons = TAB_ICONS[route.name as keyof TabParamList]
            return (
              <Ionicons
                name={focused ? icons.active : icons.inactive}
                size={size}
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
