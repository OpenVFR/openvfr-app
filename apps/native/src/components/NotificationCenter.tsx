/**
 * NotificationCenter (native) — single consolidated alert/toast stack.
 *
 * RN port of web's src/components/NotificationCenter.tsx. Replaces the old
 * native AirspaceWarningBanner (which was the only alert UI native had) with
 * the same 5-source consolidated, severity-ordered stack the web app uses --
 * all four position-driven sources now come from the single combined
 * usePositionAlerts hook (see its doc comment for why they were merged):
 *   - airspaceAlerts        (persistent while airspace conflict active)
 *   - obstructionAlerts     (persistent while obstacle proximity active)
 *   - airfieldAlerts        (persistent while near unplanned aerodrome)
 *   - airspaceNotifications (transient entry/exit toasts)
 *   - ceiling-escalation msg + waypoint-reminder note (transient / dismissible)
 *
 * Layout (see @open-vfr/shared/alertStack): red alerts and at most two cards in
 * total are full cards; obstacles ahead are merged into one card; entry/exit
 * events, advisories and overflow are one-line chips. Items pass through
 * useStableItems first, so a condition must hold ~2 s before it shows and a
 * shown item stays a few seconds -- no flicker at trigger edges.
 *
 * Positioned top-centre, absolute, inside mapContainer (parent already has
 * insets.top padding applied — see MapScreen.tsx's outer container).
 */

import React, { useEffect } from 'react'
import { summarizeObstructionAlerts, obstructionSummaryText, obstructionDistLabel } from '@open-vfr/shared/obstructionPoints'
import { layoutAlertStack, type AlertTier } from '@open-vfr/shared/alertStack'
import type { StableTiming } from '@open-vfr/shared/alertStability'
import { useStableItems } from '../hooks/useStableItems'
import { View, Text, TouchableOpacity, useWindowDimensions } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler'
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import type { AirspaceAlert, AirspaceNotification, ObstructionAlert, AirfieldProximityAlert } from '../hooks/usePositionAlerts'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'

type Severity = 'red' | 'yellow' | 'blue'

interface Item extends StableTiming {
  key:         string
  tier?:       AlertTier   // set by withPolicy(); drives card vs chip layout
  chipTitle?:  string      // shorter title for the one-line chip
  short?:      string      // trailing detail shown on the one-line chip
  severity:    Severity
  badge:       string
  status?:     string
  title:       string
  meta?:       string
  text?:       string
  dismissible: boolean
  onDismiss?:  () => void
}


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
  if (a.cls === 'R')   return a.type === 'D' ? 'DANGER' : a.type === 'P' ? 'PROHIBITED' : 'RESTRICTED'
  if (a.cls === 'TRA') return 'TEMP RESERVED'
  if (/^[A-F]$/.test(a.cls) && a.type !== 'CTR') return `CLASS ${a.cls}`
  if (a.type === 'ATZ') return 'ATZ'
  if (a.type === 'RMZ') return 'RMZ'
  if (a.type === 'CTR') return `CTR ${a.cls}`
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

/** Card/chip tier and debounce timing by item kind (keys are prefixed per source). */
function withPolicy(item: Item): Item & { tier: AlertTier } {
  const instant = { enterMs: 0, minShowMs: 0, lingerMs: 0 }
  const k = item.key
  if (k === 'ceiling' || k.startsWith('nt-')) return { ...item, ...instant, tier: 'event' }
  if (k === 'reminder' || k === 'planning') return { ...item, ...instant, tier: 'note' }
  // Red hazards show at once; the rest wait a moment so edge flicker never reaches the screen.
  return { ...item, ...(item.severity === 'red' ? { enterMs: 0 } : {}), tier: 'alert' }
}

const CONTROLS_SIZE = 40   // map control button edge, dp

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
  /** Planning-time notice (e.g. a new leg's altitude raised for terrain);
   *  auto-dismisses after PLANNING_NOTICE_MS. */
  planningNotice?:       { title: string; text: string } | null
  onDismissPlanning?:    () => void
}

const AUTO_DISMISS_MS = 30_000
const PLANNING_NOTICE_MS = 10_000

export function NotificationCenter({
  airspaceAlerts, onDismissAirspace,
  obstructionAlerts, onDismissObstruction,
  airfieldAlerts, onDismissAirfield,
  airspaceNotifications, ceilingMsg,
  reminderNote, onDismissReminder,
  planningNotice, onDismissPlanning,
}: Props) {
  const styles = useThemedStyles(makeStyles)
  useEffect(() => {
    if (!reminderNote || !onDismissReminder) return
    const id = setTimeout(onDismissReminder, AUTO_DISMISS_MS)
    return () => clearTimeout(id)
  }, [reminderNote, onDismissReminder])
  useEffect(() => {
    if (!planningNotice || !onDismissPlanning) return
    const id = setTimeout(onDismissPlanning, PLANNING_NOTICE_MS)
    return () => clearTimeout(id)
  }, [planningNotice, onDismissPlanning])

  // Map control buttons sit above this stack (zIndex 50) on the right edge in
  // portrait and along the top in landscape. Reserve their space so cards are
  // never hidden underneath them.
  const { width: winW, height: winH } = useWindowDimensions()
  const controlsInset = winW > winH
    ? { top: CONTROLS_SIZE + 24 }
    : { right: CONTROLS_SIZE + 24 }

  const items: Item[] = []

  // One card per airspace: the newest transition toast (entered/left) wins
  // over the persistent alert for the same airspace; among toasts the latest
  // expiry wins; among alerts the first (inside sorts before ahead/vertical) wins.
  // Same-named sectors with different vertical bands are distinct airspaces.
  const airspaceId = (a: { name: string; cls: string; lower: string; upper: string }) =>
    `${a.name}::${a.cls}::${a.lower}-${a.upper}`
  const latestNotif = new Map<string, AirspaceNotification>()
  for (const n of airspaceNotifications) {
    const id = airspaceId(n)
    const cur = latestNotif.get(id)
    if (!cur || n.expiresAt >= cur.expiresAt) latestNotif.set(id, n)
  }
  const seenAlert = new Set<string>()
  const shownAlerts = airspaceAlerts.filter(a => {
    const id = airspaceId(a)
    if (latestNotif.has(id) || seenAlert.has(id)) return false
    seenAlert.add(id)
    return true
  })

  for (const a of shownAlerts) {
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

  // All obstacles ahead are one card, however many kinds there are.
  const obstructions = summarizeObstructionAlerts(obstructionAlerts)
  if (obstructions) {
    const { title, meta } = obstructionSummaryText(obstructions, obstructionAlerts.length === 1 ? obstructionAlerts[0].name : undefined)
    items.push({
      key: 'obstructions',
      severity: 'yellow',
      badge: obstructions.count === 1 ? '\u25b2 OBSTACLE AHEAD' : '\u25b2 OBSTACLES AHEAD',
      title,
      meta,
      chipTitle: `${obstructions.count} \u00b7 nearest ${obstructionDistLabel(obstructions.nearestNm)} NM`,
      short: `\u2191 ${obstructions.clearFt} ft`,
      dismissible: true,
      onDismiss: () => obstructions.keys.forEach(onDismissObstruction),
    })
  }

  for (const a of airfieldAlerts) {
    items.push({
      key: `af-${a.key}`,
      severity: 'blue',
      badge: '\u2708 AERODROME NEARBY',
      title: `${a.icao ? `${a.icao} \u2014 ` : ''}${a.name}`,
      meta: `${a.distNm.toFixed(1)} NM \u00b7 elev ${a.elevationFt} ft${a.primaryFreq ? ` \u00b7 ${a.primaryFreq} MHz` : ''}`,
      short: `${a.distNm.toFixed(1)} NM`,
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

  for (const n of latestNotif.values()) {
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

  if (planningNotice) {
    items.push({
      key: 'planning',
      severity: 'yellow',
      badge: '✈ CRUISE LEVEL',
      title: planningNotice.title,
      text: planningNotice.text,
      dismissible: true,
      onDismiss: onDismissPlanning,
    })
  }

  // Debounce first (no flicker at trigger edges), then split into a few full
  // cards and one-line chips.
  const { visible: stable, forget } = useStableItems(items.map(withPolicy))
  if (stable.length === 0) return null
  const { cards, chips, overflow } = layoutAlertStack(stable.map(i => ({ ...i, tier: i.tier as AlertTier })))
  const dismissOf = (item: Item) => item.onDismiss && (() => { forget(item.key); item.onDismiss?.() })

  return (
    <View style={[styles.container, controlsInset]} pointerEvents="box-none">
      {cards.map(item => {
        const bg     = SEVERITY_BG[item.severity]
        const border = SEVERITY_BORDER[item.severity]
        const accent = SEVERITY_ACCENT[item.severity]
        const dismiss = dismissOf(item)
        return (
          <SwipeableCard key={item.key} dismissible={item.dismissible} onDismiss={dismiss}>
            <View style={[styles.card, { backgroundColor: bg, borderLeftColor: border }]}>
              <View style={styles.header}>
                <Text style={[styles.badge, { color: accent }]} numberOfLines={1}>{item.badge}</Text>
                {item.status && <Text style={styles.status}>{item.status}</Text>}
                {item.dismissible && dismiss && (
                  <TouchableOpacity
                    style={styles.dismissBtn}
                    onPress={dismiss}
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
      {chips.map(item => {
        const accent = SEVERITY_ACCENT[item.severity]
        const dismiss = dismissOf(item)
        return (
          <SwipeableCard key={item.key} dismissible={item.dismissible} onDismiss={dismiss}>
            <View style={[styles.chip, { backgroundColor: SEVERITY_BG[item.severity], borderLeftColor: SEVERITY_BORDER[item.severity] }]}>
              <Text style={[styles.chipBadge, { color: accent }]} numberOfLines={1}>{item.badge}</Text>
              <Text style={styles.chipTitle} numberOfLines={1}>{item.chipTitle ?? item.title}</Text>
              {(item.status || item.short) && <Text style={styles.chipShort} numberOfLines={1}>{item.status ?? item.short}</Text>}
              {item.dismissible && dismiss && (
                <TouchableOpacity
                  onPress={dismiss}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="close" size={12} color={accent} />
                </TouchableOpacity>
              )}
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
      if (finished && onDismiss) scheduleOnRN(onDismiss)
    })
  }

  // Gesture Handler 3 hook API (the Gesture.Pan() builder is deprecated).
  // onDeactivate replaces v2's onEnd; callbacks run on the UI thread.
  const pan = usePanGesture({
    enabled: dismissible && !!onDismiss,
    onUpdate: e => {
      'worklet'
      translateX.value = e.translationX
    },
    onDeactivate: e => {
      'worklet'
      const ratio = Math.abs(e.translationX) / Math.max(width.value, 1)
      if (ratio > SWIPE_DISMISS_RATIO || Math.abs(e.velocityX) > SWIPE_VELOCITY_THRESHOLD) {
        triggerDismiss(e.translationX < 0 ? -1 : 1)
      } else {
        translateX.value = withTiming(0, { duration: 150 })
      }
    },
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
  chip: {
    width:          '100%',
    maxWidth:       360,
    borderRadius:   theme.radiusMd,
    borderLeftWidth: 4,
    paddingHorizontal: theme.space2,
    paddingVertical:   4,
    flexDirection:  'row',
    alignItems:     'center',
    gap:            6,
  },
  chipBadge: {
    fontSize:       9,
    fontWeight:     '700',
    letterSpacing:  0.4,
    textTransform:  'uppercase',
  },
  chipTitle: {
    flex:       1,
    color:      '#ffffff',
    fontSize:   12,
    fontWeight: '600',
  },
  chipShort: {
    color:      '#ffffff',
    opacity:    0.9,
    fontSize:   10,
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
