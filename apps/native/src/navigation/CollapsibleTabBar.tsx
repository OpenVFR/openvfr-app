/**
 * CollapsibleTabBar -- icon-only bottom tab bar that collapses to a thin
 * handle strip.
 *
 *  - Icons only (labels dropped to save space); accessibility labels and
 *    test IDs are kept so screen readers and UI automation still work.
 *  - Swipe down on the bar to collapse it, swipe up (or tap) on the handle
 *    to bring it back.
 *  - The collapsed state lives in TabBarContext so MapScreen can collapse it
 *    automatically when a flight mode starts.
 *  - The bottom safe-area inset is part of the bar in both states but is
 *    NOT part of the gesture area: on gesture-navigation phones the bottom
 *    edge belongs to the system (swipe up = home / recents) and apps cannot
 *    exclude it, so only the handle/icon strip above the inset reacts to
 *    swipes. A swipe that starts in the inset goes to Android, as expected.
 *    Tapping the handle always works as an alternative.
 */
import React, { useEffect } from 'react'
import { View, TouchableOpacity, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs'
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { theme, useScaledTheme } from '../styles/theme'
import { useTabBarCollapsed } from '../context/TabBarContext'

type IoniconName = React.ComponentProps<typeof Ionicons>['name']

const TAB_ICONS: Record<string, { active: IoniconName; inactive: IoniconName }> = {
  Map:      { active: 'map',      inactive: 'map-outline'      },
  Plan:     { active: 'navigate', inactive: 'navigate-outline' },
  Settings: { active: 'settings', inactive: 'settings-outline' },
}

const HANDLE_ZONE    = 16   // dp: handle touch target when collapsed; drawn inside the bottom inset so it adds no height
const COLLAPSED_EXTRA = 4   // dp: bar height above the bottom inset when collapsed
const HANDLE_TOUCH_EXPANDED = 10 // dp: handle touch strip while expanded (must not cover the icons)
const ICON_ZONE      = 32   // dp: height of the bar when expanded (icons; handle overlays the top edge)
const ANIM_MS        = 220
const SWIPE_DISTANCE = 20   // dp of vertical travel that counts as a swipe

export function CollapsibleTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const scaledTheme = useScaledTheme()
  const insets = useSafeAreaInsets()
  const { collapsed, setCollapsed } = useTabBarCollapsed()

  const handleZone = scaledTheme.scale(HANDLE_ZONE)
  const iconZone   = scaledTheme.scale(ICON_ZONE)
  const collapsedExtra = scaledTheme.scale(COLLAPSED_EXTRA)
  // Scaled values must be computed here: scaledTheme.scale is a JS function
  // and cannot be called from inside an animated-style worklet.
  const handleTouchExpanded = scaledTheme.scale(HANDLE_TOUCH_EXPANDED)

  // 1 = expanded, 0 = collapsed. Driven from the context so both gestures and
  // programmatic changes (entering flight mode) animate the same way.
  const progress = useSharedValue(collapsed ? 0 : 1)
  useEffect(() => {
    progress.value = withTiming(collapsed ? 0 : 1, { duration: ANIM_MS })
  }, [collapsed, progress])

  const pan = usePanGesture({
    activeOffsetY: [-10, 10],
    failOffsetX:   [-20, 20],
    // Decide as soon as the swipe passes the threshold instead of on release:
    // a touch that drifts into the system gesture zone gets cancelled by
    // Android and would never deliver a release callback.
    onUpdate: e => {
      'worklet'
      if (e.translationY > SWIPE_DISTANCE) scheduleOnRN(setCollapsed, true)
      else if (e.translationY < -SWIPE_DISTANCE) scheduleOnRN(setCollapsed, false)
    },
  })

  const containerStyle = useAnimatedStyle(() => ({
    height: insets.bottom + collapsedExtra + (iconZone - collapsedExtra) * progress.value,
  }))
  const iconsStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
  }))
  // Tall touch target when collapsed, thin strip when expanded so it never
  // covers the icons underneath.
  const handleStyle = useAnimatedStyle(() => ({
    height: handleZone * (1 - progress.value) + handleTouchExpanded * progress.value,
  }))

  return (
    <Animated.View style={[styles.bar, containerStyle, { paddingBottom: insets.bottom }]}>
      <GestureDetector gesture={pan}>
        <View style={styles.content}>
        <Animated.View style={[styles.handleZone, handleStyle]}>
          <TouchableOpacity
            style={styles.handleTouch}
            activeOpacity={0.7}
            onPress={() => setCollapsed(!collapsed)}
            accessibilityRole="button"
            accessibilityLabel={collapsed ? 'Show navigation bar' : 'Hide navigation bar'}
            testID="tab-bar-handle"
          >
            <View style={styles.handle} />
          </TouchableOpacity>
        </Animated.View>

        <Animated.View style={[styles.icons, { height: iconZone }, iconsStyle]} pointerEvents={collapsed ? 'none' : 'auto'}>
          {state.routes.map((route, index) => {
            const { options } = descriptors[route.key]
            const focused = state.index === index
            const icons = TAB_ICONS[route.name]
            const color = focused ? theme.accentBlue : theme.textMuted
            const label = typeof options.tabBarLabel === 'string' ? options.tabBarLabel : route.name

            const onPress = () => {
              const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true })
              if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params)
            }
            return (
              <TouchableOpacity
                key={route.key}
                style={styles.tab}
                onPress={onPress}
                onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
                accessibilityRole="tab"
                accessibilityState={{ selected: focused }}
                accessibilityLabel={options.tabBarAccessibilityLabel ?? label}
                testID={options.tabBarButtonTestID}
              >
                <Ionicons
                  name={icons ? (focused ? icons.active : icons.inactive) : 'ellipse-outline'}
                  size={scaledTheme.scale(20)}
                  color={color}
                />
              </TouchableOpacity>
            )
          })}
        </Animated.View>
        </View>
      </GestureDetector>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: theme.surfacePanel,
    borderTopColor:  theme.borderDefault,
    borderTopWidth:  1,
    overflow:        'hidden',
  },
  // Overlays the top edge of the bar (absolute) so it costs no height of its
  // own when the bar is expanded.
  // Everything above the bottom inset; the only region that handles swipes.
  content: {
    flex: 1,
  },
  handleZone: {
    position:       'absolute',
    top:            0,
    left:           0,
    right:          0,
    zIndex:         1,
    alignItems:     'center',
  },
  handleTouch: {
    flex:           1,
    alignSelf:      'stretch',
    alignItems:     'center',
    justifyContent: 'flex-start',
    paddingTop:     3,
  },
  handle: {
    width:           36,
    height:          4,
    borderRadius:    2,
    backgroundColor: theme.borderDefault,
  },
  icons: {
    flexDirection: 'row',
    position:      'absolute',
    top:           0,
    left:          0,
    right:         0,
    paddingTop:    5,
  },
  tab: {
    flex:           1,
    alignItems:     'center',
    justifyContent: 'center',
  },
})
