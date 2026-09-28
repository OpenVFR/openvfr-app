/**
 * Tab navigator — three tabs: Map | Plan | Settings
 */

import React from 'react'
import { NavigationContainer } from '@react-navigation/native'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

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
  const iconSize = scaledTheme.scale(20)
  // Setting height/paddingBottom below replaces React Navigation's own
  // safe-area handling, so the bottom inset has to be added back by hand.
  // Without it the tab bar sits under the home indicator (iOS) or the
  // navigation bar / tablet taskbar (Android is always edge-to-edge), and
  // on tablets the taskbar covers it entirely.
  const insets = useSafeAreaInsets()
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarStyle: {
            backgroundColor: theme.surfacePanel,
            borderTopColor:  theme.borderDefault,
            borderTopWidth:  1,
            height: scaledTheme.scale(46) + insets.bottom,
            paddingBottom: scaledTheme.space0 + insets.bottom,
            paddingTop: scaledTheme.space0,
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
        {/* Test IDs for UI automation (.maestro/screenshots.yaml): on iOS the
            tab's accessibility label is "<label>, tab, N of M", so matching
            by visible label text only works on Android. */}
        <Tab.Screen name="Map"      component={MapScreen}      options={{ tabBarButtonTestID: 'tab-map' }} />
        <Tab.Screen name="Plan"     component={PlanScreen}     options={{ tabBarLabel: 'Flight Plan', tabBarButtonTestID: 'tab-plan' }} />
        <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarButtonTestID: 'tab-settings' }} />
      </Tab.Navigator>
    </NavigationContainer>
  )
}
