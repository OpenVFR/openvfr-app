/**
 * CollapsibleTabBar -- icon-only bottom tab bar that collapses to a thin
 * handle strip.
 *
 *  - Icons only (labels dropped to save space); accessibility labels and
 *    test IDs are kept so screen readers and UI automation still work.
 *  - Drag the bar up/down: its height follows the finger and snaps open or
 *    shut on release (a fling toggles it). Tapping a handle also toggles it.
 *  - Handles sit between the icons (and at the outer edges): wide,
 *    full-height touch targets, so toggling never needs a precise hit on a
 *    thin strip.
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

const COLLAPSED_EXTRA = 4   // dp: bar height above the bottom inset when collapsed
const GAP_HANDLE_WIDTH = 48 // dp: touch width of each handle between icons
const ICON_ZONE      = 32   // dp: height of the bar when expanded (icons; handle overlays the top edge)
const ANIM_MS        = 220
const SWIPE_FLING_VELOCITY = 600 // dp/s: a fling this fast toggles regardless of position

export function CollapsibleTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const scaledTheme = useScaledTheme()
  const insets = useSafeAreaInsets()
  const { collapsed, setCollapsed } = useTabBarCollapsed()

  const iconZone   = scaledTheme.scale(ICON_ZONE)
  const collapsedExtra = scaledTheme.scale(COLLAPSED_EXTRA)

  // 1 = expanded, 0 = collapsed. Driven from the context so both gestures and
  // programmatic changes (entering flight mode) animate the same way.
  const progress = useSharedValue(collapsed ? 0 : 1)
  useEffect(() => {
    progress.value = withTiming(collapsed ? 0 : 1, { duration: ANIM_MS })
  }, [collapsed, progress])

  // Drag-to-resize: the bar height follows the finger 1:1, then snaps open or
  // shut on release (fling velocity wins, otherwise nearest half). Snapping is
  // done in onFinalize, not onDeactivate, because a touch that drifts into the
  // Android system-gesture zone is cancelled and would never deliver a normal
  // release.
  const dragRange  = Math.max(1, iconZone - collapsedExtra)
  const dragStart  = useSharedValue(1)
  const dragging   = useSharedValue(false)
  const lastVelY   = useSharedValue(0)  // finalize events carry no velocity, so track it per update
  const pan = usePanGesture({
    activeOffsetY: [-10, 10],
    failOffsetX:   [-20, 20],
    onActivate: () => {
      'worklet'
      dragStart.value = progress.value
      dragging.value  = true
    },
    onUpdate: e => {
      'worklet'
      progress.value = Math.min(1, Math.max(0, dragStart.value - e.translationY / dragRange))
      lastVelY.value = e.velocityY
    },
    onFinalize: () => {
      'worklet'
      if (!dragging.value) return
      dragging.value = false
      const v = lastVelY.value
      const target = v > SWIPE_FLING_VELOCITY ? 0 : v < -SWIPE_FLING_VELOCITY ? 1 : progress.value > 0.5 ? 1 : 0
      progress.value = withTiming(target, { duration: ANIM_MS })
      scheduleOnRN(setCollapsed, target === 0)
    },
  })

  const containerStyle = useAnimatedStyle(() => ({
    height: insets.bottom + collapsedExtra + (iconZone - collapsedExtra) * progress.value,
  }))
  const iconsStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
  }))
  return (
    <Animated.View style={[styles.bar, containerStyle, { paddingBottom: insets.bottom }]}>
      <GestureDetector gesture={pan}>
        <View style={styles.content}>
        <View style={[styles.icons, { height: iconZone }]} pointerEvents="box-none">
          {state.routes.map((route, index) => {
            const gapHandle = (key: string) => (
              <TouchableOpacity
                key={key}
                style={[styles.gapHandle, { width: scaledTheme.scale(GAP_HANDLE_WIDTH) }]}
                activeOpacity={0.6}
                onPress={() => setCollapsed(!collapsed)}
                accessibilityRole="button"
                accessibilityLabel={collapsed ? 'Show navigation bar' : 'Hide navigation bar'}
                testID={key === 'start' ? 'tab-bar-handle' : `tab-bar-gap-handle-${key}`}
              >
                <View style={styles.gapPill} />
              </TouchableOpacity>
            )
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
              <React.Fragment key={route.key}>
              {index === 0 && gapHandle('start')}
              <Animated.View style={[styles.tab, iconsStyle]} pointerEvents={collapsed ? 'none' : 'auto'}>
              <TouchableOpacity
                style={styles.tabTouch}
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
              </Animated.View>
              {gapHandle(index === state.routes.length - 1 ? 'end' : `${index}`)}
              </React.Fragment>
            )
          })}
        </View>
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
  // Everything above the bottom inset; the only region that handles swipes.
  content: {
    flex: 1,
  },
  icons: {
    flexDirection: 'row',
    position:      'absolute',
    top:           0,
    left:          0,
    right:         0,
    paddingTop:    5,
  },
  // Full-height grab target between icons; the horizontal pill at the top edge
  // matches the main handle and is a visual cue only.
  gapHandle: {
    alignSelf:      'stretch',
    alignItems:     'center',
    justifyContent: 'flex-start',
    paddingTop:     2,
    // Cancel the icon row's paddingTop (5) so the pill sits at the exact
    // vertical position the old centre handle had (2 dp from the bar's top).
    marginTop:      -5,
  },
  gapPill: {
    width:           24,
    height:          3,
    borderRadius:    2,
    backgroundColor: theme.textMuted,
    opacity:         0.45,
  },
  tabTouch: {
    flex:           1,
    alignSelf:      'stretch',
    alignItems:     'center',
    justifyContent: 'center',
  },
  tab: {
    flex:           1,
    alignItems:     'center',
    justifyContent: 'center',
  },
})
