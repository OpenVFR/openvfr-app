/**
 * NotificationCenter (native) — single consolidated alert/toast stack.
 *
 * RN port of web's src/components/NotificationCenter.tsx. Replaces the old
 * native AirspaceWarningBanner (which was the only alert UI native had) with
 * the same 5-source consolidated, severity-ordered stack the web app uses:
 *   - useAirspaceWarnings        (persistent while airspace conflict active)
 *   - useObstructionWarnings     (persistent while obstacle proximity active)
 *   - useAirfieldProximity       (persistent while near unplanned aerodrome)
 *   - useAirspaceNotifications   (transient entry/exit toasts)
 *   - ceiling-escalation msg + waypoint-reminder note (transient / dismissible)
 *
 * Positioned top-centre, absolute, inside mapContainer (parent already has
 * insets.top padding applied — see MapScreen.tsx's outer container).
 */

import React, { useEffect } from 'react'
import { View, Text, TouchableOpacity } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  runOnJS,
} from 'react-native-reanimated'
import type { AirspaceAlert } from '../hooks/useAirspaceWarnings'
import type { AirspaceNotification } from '../hooks/useAirspaceNotifications'
import type { ObstructionAlert } from '../hooks/useObstructionWarnings'
import type { AirfieldProximityAlert } from '../hooks/useAirfieldProximity'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'

type Severity = 'red' | 'yellow' | 'blue'

interface Item {
  key:         string
  severity:    Severity
  badge:       string
  status?:     string
  title:       string
  meta?:       string
  text?:       string
  dismissible: boolean
  onDismiss?:  () => void
}

const SEVERITY_ORDER: Record<Severity, number> = { red: 0, yellow: 1, blue: 2 }

// Near-opaque backgrounds — legibility over a busy map matters more than
// see-through chrome (mirrors web's --alert-bg-* tokens; also fixes the
// old AirspaceWarningBanner's 0.18-alpha readability bug).
const SEVERITY_BG: Record<Severity, string> = {
  red:    'rgba(180,30,30,0.92)',
  yellow: 'rgba(160,110,0,0.92)',
  blue:   'rgba(20,60,140,0.92)',
}
const SEVERITY_BORDER: Record<Severity, string> = {
  red:    '#ff4444',
  yellow: '#f5c518',
  blue:   '#5a9cf5',
}
const SEVERITY_ACCENT: Record<Severity, string> = {
  red:    '#ff6666',
  yellow: '#ffdd55',
  blue:   '#8ab8ff',
}

const CLS_LABEL: Record<string, string> = {
  A: 'Class A', B: 'Class B', C: 'Class C', D: 'Class D',
  E: 'Class E', G: 'Class G', R: 'Restricted', TRA: 'TRA',
  CTR: 'CTR', GLDR: 'Glider', MODEL: 'Model', RMZ: 'RMZ', ATZ: 'ATZ',
}
function clsLabel(cls: string, type: string): string {
  return CLS_LABEL[cls] ?? CLS_LABEL[type] ?? (cls || type)
}

function airspaceSeverityLabel(a: AirspaceAlert): string {
  if (a.cls === 'R')   return 'RESTRICTED'
  if (a.cls === 'TRA') return 'TEMP RESERVED'
  if (a.cls === 'C')   return 'CLASS C'
  if (a.cls === 'D')   return 'DANGER'
  if (a.type === 'ATZ') return 'ATZ'
  if (a.type === 'RMZ') return 'RMZ'
  if (a.type === 'CTR') return 'CTR'
  if (a.cls === 'E')   return 'CLASS E'
  if (a.cls === 'GLDR') return 'GLIDER AREA'
  if (a.cls === 'MODEL') return 'MODEL FLYING'
  return a.cls || a.type
}

function airspaceStatus(a: AirspaceAlert): string {
  if (a.verticalClosure === 'floor')   return `\u2191 CLIMBING +${a.gapFt}ft`
  if (a.verticalClosure === 'ceiling') return `\u2193 DESCENDING +${a.gapFt}ft`
  if (a.inside) return '\u25b2 INSIDE'
  return '\u26a0 AHEAD'
}

const OBSTRUCTION_KIND_LABEL: Record<string, string> = {
  wind_turbine: '\u27f3 WIND TURBINE',
  tower:        '\u25b2 TOWER',
  chimney:      '\u25b2 CHIMNEY',
  building:     '\u25a3 BUILDING',
  other:        '\u25b2 OBSTACLE',
}

const MAX_VISIBLE = 5

interface Props {
  airspaceAlerts:        AirspaceAlert[]
  onDismissAirspace:     (key: string) => void
  obstructionAlerts:     ObstructionAlert[]
  onDismissObstruction:  (key: string) => void
  airfieldAlerts:        AirfieldProximityAlert[]
  onDismissAirfield:     (key: string) => void
  airspaceNotifications: AirspaceNotification[]
  ceilingMsg?:           string | null
  reminderNote?:         { wpName: string; text: string } | null
  onDismissReminder?:    () => void
}

const AUTO_DISMISS_MS = 30_000

export function NotificationCenter({
  airspaceAlerts, onDismissAirspace,
  obstructionAlerts, onDismissObstruction,
  airfieldAlerts, onDismissAirfield,
  airspaceNotifications, ceilingMsg,
  reminderNote, onDismissReminder,
}: Props) {
  const styles = useThemedStyles(makeStyles)
  useEffect(() => {
    if (!reminderNote || !onDismissReminder) return
    const id = setTimeout(onDismissReminder, AUTO_DISMISS_MS)
    return () => clearTimeout(id)
  }, [reminderNote, onDismissReminder])

  const items: Item[] = []

  for (const a of airspaceAlerts) {
    items.push({
      key: `as-${a.key}`,
      severity: a.severity,
      badge: airspaceSeverityLabel(a),
      status: airspaceStatus(a),
      title: a.name,
      meta: `${a.lower} \u2013 ${a.upper}`,
      dismissible: true,
      onDismiss: () => onDismissAirspace(a.key),
    })
  }

  for (const a of obstructionAlerts) {
    items.push({
      key: `ob-${a.key}`,
      severity: 'yellow',
      badge: OBSTRUCTION_KIND_LABEL[a.kind] ?? '\u25b2 OBSTACLE',
      title: a.name || a.kind.replace('_', ' '),
      meta: `${a.tipFt > a.elevationFt ? `Top ${a.tipFt} ft \u00b7 base ${a.elevationFt} ft AMSL` : `${a.elevationFt} ft AMSL`} \u00b7 ${a.distNm < 0.1 ? '<0.1' : a.distNm.toFixed(1)} NM`,
      dismissible: true,
      onDismiss: () => onDismissObstruction(a.key),
    })
  }

  for (const a of airfieldAlerts) {
    items.push({
      key: `af-${a.key}`,
      severity: 'blue',
      badge: '\u2708 AERODROME NEARBY',
      title: `${a.icao ? `${a.icao} \u2014 ` : ''}${a.name}`,
      meta: `${a.distNm.toFixed(1)} NM \u00b7 elev ${a.elevationFt} ft${a.primaryFreq ? ` \u00b7 ${a.primaryFreq} MHz` : ''}`,
      dismissible: true,
      onDismiss: () => onDismissAirfield(a.key),
    })
  }

  if (ceilingMsg) {
    items.push({
      key: 'ceiling',
      severity: 'blue',
      badge: '\u25b2 CEILING FILTER',
      title: ceilingMsg,
      dismissible: false,
    })
  }

  for (const n of airspaceNotifications) {
    items.push({
      key: `nt-${n.id}`,
      severity: n.severity,
      badge: clsLabel(n.cls, n.type),
      status: n.direction === 'entered' ? '\u25b6 ENTERED' : '\u25c0 LEFT',
      title: n.name,
      meta: `${n.lower} \u2013 ${n.upper}`,
      dismissible: false,
    })
  }

  if (reminderNote) {
    items.push({
      key: 'reminder',
      severity: 'yellow',
      badge: '\ud83d\udccd WAYPOINT NOTE',
      title: reminderNote.wpName,
      text: reminderNote.text,
      dismissible: true,
      onDismiss: onDismissReminder,
    })
  }

  if (items.length === 0) return null

  items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  const visible = items.slice(0, MAX_VISIBLE)
  const overflow = items.length - MAX_VISIBLE

  return (
    <View style={styles.container} pointerEvents="box-none">
      {visible.map(item => {
        const bg     = SEVERITY_BG[item.severity]
        const border = SEVERITY_BORDER[item.severity]
        const accent = SEVERITY_ACCENT[item.severity]
        return (
          <SwipeableCard key={item.key} dismissible={item.dismissible} onDismiss={item.onDismiss}>
            <View style={[styles.card, { backgroundColor: bg, borderLeftColor: border }]}>
              <View style={styles.header}>
                <Text style={[styles.badge, { color: accent }]} numberOfLines={1}>{item.badge}</Text>
                {item.status && <Text style={styles.status}>{item.status}</Text>}
                {item.dismissible && item.onDismiss && (
                  <TouchableOpacity
                    style={styles.dismissBtn}
                    onPress={item.onDismiss}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="close" size={14} color={accent} />
                  </TouchableOpacity>
                )}
              </View>
              <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
              {item.meta && <Text style={styles.meta}>{item.meta}</Text>}
              {item.text && <Text style={styles.text}>{item.text}</Text>}
            </View>
          </SwipeableCard>
        )
      })}
      {overflow > 0 && (
        <Text style={styles.overflow}>+{overflow} more</Text>
      )}
    </View>
  )
}

// Swipe left/right past ~30% of card width (or a fast flick) dismisses the
// card — mirrors the standard native notification-shade gesture. Cards that
// aren't dismissible (ceilingMsg, live entry/exit toasts) render inert, no
// gesture attached.
const SWIPE_DISMISS_RATIO = 0.3
const SWIPE_VELOCITY_THRESHOLD = 800
const CARD_WIDTH_FALLBACK = 360

function SwipeableCard({
  children, dismissible, onDismiss,
}: { children: React.ReactNode; dismissible: boolean; onDismiss?: () => void }) {
  const translateX = useSharedValue(0)
  const opacity     = useSharedValue(1)
  const width       = useSharedValue(CARD_WIDTH_FALLBACK)

  const triggerDismiss = (direction: 1 | -1) => {
    'worklet'
    translateX.value = withTiming(direction * (width.value + 40), { duration: 180 })
    opacity.value = withTiming(0, { duration: 180 }, finished => {
      if (finished && onDismiss) runOnJS(onDismiss)()
    })
  }

  const pan = Gesture.Pan()
    .enabled(dismissible && !!onDismiss)
    .onUpdate(e => { translateX.value = e.translationX })
    .onEnd(e => {
      const ratio = Math.abs(e.translationX) / Math.max(width.value, 1)
      if (ratio > SWIPE_DISMISS_RATIO || Math.abs(e.velocityX) > SWIPE_VELOCITY_THRESHOLD) {
        triggerDismiss(e.translationX < 0 ? -1 : 1)
      } else {
        translateX.value = withTiming(0, { duration: 150 })
      }
    })

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
    opacity: opacity.value,
  }))

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[{ width: '100%', maxWidth: 360 }, animatedStyle]}
        onLayout={e => { width.value = e.nativeEvent.layout.width }}
      >
        {children}
      </Animated.View>
    </GestureDetector>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  container: {
    position:       'absolute',
    top:            theme.space2,
    left:           theme.space4,
    right:          theme.space4,
    alignItems:     'center',
    gap:            theme.space1 + 2,
    zIndex:         10,
  },
  card: {
    width:          '100%',
    maxWidth:       360,
    borderRadius:   theme.radiusMd,
    borderLeftWidth: 4,
    padding:        theme.space2,
    gap:            2,
  },
  header: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           6,
  },
  badge: {
    flex:           1,
    fontSize:       theme.textXs,
    fontWeight:     '700',
    letterSpacing:  0.5,
    textTransform:  'uppercase',
  },
  status: {
    color:      '#ffffff',
    opacity:    0.9,
    fontSize:   9,
  },
  dismissBtn: {
    padding: 2,
  },
  title: {
    color:      '#ffffff',
    fontSize:   13,
    fontWeight: '700',
  },
  meta: {
    color:    '#ffffff',
    opacity:  0.85,
    fontSize: 11,
  },
  text: {
    color:      '#ffffff',
    opacity:    0.95,
    fontSize:   12,
    lineHeight: 17,
    marginTop:  2,
  },
  overflow: {
    color:     theme.textMuted,
    fontSize:  11,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: theme.radiusMd,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
} as const
}
