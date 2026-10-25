/**
 * NotificationCenter — single consolidated alert/toast stack.
 *
 * Replaces 5 previously-scattered components (top-left, top-right,
 * top-centre, bottom-left, bottom-right) with one severity-ordered stack,
 * positioned top-centre, so the pilot only has one place to glance.
 *
 * Feeds:
 *   - AirspaceWarningBanner   (persistent while airspace conflict active)
 *   - ObstructionWarningBanner(persistent while obstacle proximity active)
 *   - AirfieldProximityBanner (persistent while near unplanned aerodrome)
 *   - AirspaceNotificationToast (transient entry/exit + ceiling-escalation)
 *   - WaypointReminderToast   (transient, single item, 30s auto-dismiss)
 */

import { useEffect } from 'react'
import { summarizeObstructionAlerts, obstructionSummaryText, obstructionDistLabel } from '@open-vfr/shared/obstructionPoints'
import { layoutAlertStack, type AlertTier } from '@open-vfr/shared/alertStack'
import type { StableTiming } from '@open-vfr/shared/alertStability'
import { useStableItems } from '../hooks/useStableItems'
import type { AirspaceAlert } from '../hooks/useAirspaceWarnings'
import type { AirspaceNotification } from '../hooks/useAirspaceNotifications'
import type { ObstructionAlert } from '../hooks/useObstructionWarnings'
import type { AirfieldProximityAlert } from '../hooks/useAirfieldProximity'
import type { NotamAlert } from '../hooks/useNotamWarnings'
import type { NotamNotification } from '../hooks/useNotamNotifications'
import css from './NotificationCenter.module.css'

type Severity = 'red' | 'yellow' | 'blue'

interface Item extends StableTiming {
  key:         string
  tier?:       AlertTier         // set by withPolicy(); drives card vs chip layout
  chipTitle?:  string            // shorter title for the one-line chip
  short?:      string            // trailing detail shown on the one-line chip
  severity:    Severity
  badge:       string            // small uppercase label, top-left of card
  status?:     string            // small label, top-right of card (optional)
  title:       string            // main line (name)
  meta?:       string            // secondary line (altitude / distance / freq)
  text?:       string            // free-text body (waypoint reminder note)
  dismissible: boolean
  onDismiss?:  () => void
  transient?:  boolean           // fades out on its own (CSS animation)
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
  if (a.verticalClosure === 'floor')   return `↑ CLIMBING +${a.gapFt}ft`
  if (a.verticalClosure === 'ceiling') return `↓ DESCENDING +${a.gapFt}ft`
  if (a.inside) return '▲ INSIDE'
  return '⚠ AHEAD'
}

/** Card/chip tier and debounce timing by item kind (keys are prefixed per source). */
function withPolicy(item: Item): Item & { tier: AlertTier } {
  const instant = { enterMs: 0, minShowMs: 0, lingerMs: 0 }
  const k = item.key
  if (k === 'ceiling' || k.startsWith('nt-') || k.startsWith('nmn-')) return { ...item, ...instant, tier: 'event' }
  if (k === 'reminder' || k === 'planning') return { ...item, ...instant, tier: 'note' }
  // Red hazards show at once; the rest wait a moment so edge flicker never reaches the screen.
  return { ...item, ...(item.severity === 'red' ? { enterMs: 0 } : {}), tier: 'alert' }
}
const AUTO_DISMISS_MS = 30_000
const PLANNING_NOTICE_MS = 10_000

interface Props {
  airspaceAlerts:        AirspaceAlert[]
  onDismissAirspace:     (key: string) => void
  obstructionAlerts:     ObstructionAlert[]
  onDismissObstruction:  (key: string) => void
  airfieldAlerts:        AirfieldProximityAlert[]
  onDismissAirfield:     (key: string) => void
  airspaceNotifications: AirspaceNotification[]
  notamAlerts?:          NotamAlert[]
  onDismissNotam?:       (key: string) => void
  notamNotifications?:   NotamNotification[]
  ceilingMsg?:           string | null
  reminderNote?:         { wpName: string; text: string } | null
  onDismissReminder?:    () => void
  /** Planning-time notice (e.g. a new leg's altitude raised for terrain);
   *  auto-dismisses after PLANNING_NOTICE_MS. */
  planningNotice?:       { title: string; text: string } | null
  onDismissPlanning?:    () => void
}

export function NotificationCenter({
  airspaceAlerts, onDismissAirspace,
  obstructionAlerts, onDismissObstruction,
  airfieldAlerts, onDismissAirfield,
  airspaceNotifications,
  notamAlerts = [], onDismissNotam,
  notamNotifications = [],
  ceilingMsg,
  reminderNote, onDismissReminder,
  planningNotice, onDismissPlanning,
}: Props) {
  // Waypoint reminder auto-dismisses after 30s.
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
      meta: `${a.lower} – ${a.upper}`,
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
      badge: obstructions.count === 1 ? '▲ OBSTACLE AHEAD' : '▲ OBSTACLES AHEAD',
      title,
      meta,
      chipTitle: `${obstructions.count} \u00b7 nearest ${obstructionDistLabel(obstructions.nearestNm)} NM`,
      short: `top ${obstructions.highestTipFt} ft`,
      dismissible: true,
      onDismiss: () => obstructions.keys.forEach(onDismissObstruction),
    })
  }

  for (const a of airfieldAlerts) {
    items.push({
      key: `af-${a.key}`,
      severity: 'blue',
      badge: '✈ AERODROME NEARBY',
      title: `${a.icao ? `${a.icao} — ` : ''}${a.name}`,
      meta: `${a.distNm.toFixed(1)} NM · elev ${a.elevationFt} ft${a.primaryFreq ? ` · ${a.primaryFreq} MHz` : ''}`,
      short: `${a.distNm.toFixed(1)} NM`,
      dismissible: true,
      onDismiss: () => onDismissAirfield(a.key),
    })
  }

  if (ceilingMsg) {
    items.push({
      key: 'ceiling',
      severity: 'blue',
      badge: '▲ CEILING FILTER',
      title: ceilingMsg,
      dismissible: false,
      transient: true,
    })
  }

  for (const n of latestNotif.values()) {
    items.push({
      key: `nt-${n.id}`,
      severity: n.severity,
      badge: clsLabel(n.cls, n.type),
      status: n.direction === 'entered' ? '▶ ENTERED' : '◀ LEFT',
      title: n.name,
      meta: `${n.lower} – ${n.upper}`,
      dismissible: false,
      transient: true,
    })
  }

  // NOTAM circles are always treated as 'red' severity -- restricted/danger
  // areas by nature, and we don't currently have a vertical band to soften
  // that (see useNotamWarnings.ts's simplification note).
  for (const a of notamAlerts) {
    items.push({
      key: `nm-${a.key}`,
      severity: 'red',
      badge: 'NOTAM',
      status: a.inside ? '▲ INSIDE' : '⚠ AHEAD',
      title: a.notamId,
      meta: `${a.text.slice(0, 80)}${a.text.length > 80 ? '…' : ''}`,
      dismissible: true,
      onDismiss: onDismissNotam ? () => onDismissNotam(a.key) : undefined,
    })
  }

  for (const n of notamNotifications) {
    items.push({
      key: `nmn-${n.id}`,
      severity: 'red',
      badge: 'NOTAM',
      status: n.direction === 'entered' ? '▶ ENTERED' : '◀ LEFT',
      title: n.notamId,
      meta: `${n.text.slice(0, 80)}${n.text.length > 80 ? '…' : ''}`,
      dismissible: false,
      transient: true,
    })
  }

  if (reminderNote) {
    items.push({
      key: 'reminder',
      severity: 'yellow',
      badge: '📍 WAYPOINT NOTE',
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
    <div className={css.container} role="alert" aria-live="polite">
      {cards.map(item => (
        <div
          key={item.key}
          className={`${css.card} ${css[item.severity]} ${item.transient ? css.transientCard : ''}`}
        >
          <div className={css.header}>
            <span className={css.badge}>{item.badge}</span>
            {item.status && <span className={css.status}>{item.status}</span>}
            {item.dismissible && item.onDismiss && (
              <button
                className={css.dismiss}
                onClick={dismissOf(item)}
                aria-label="Dismiss"
              >✕</button>
            )}
          </div>
          <div className={css.title}>{item.title}</div>
          {item.meta && <div className={css.meta}>{item.meta}</div>}
          {item.text && <div className={css.text}>{item.text}</div>}
        </div>
      ))}
      {chips.map(item => (
        <div
          key={item.key}
          className={`${css.chip} ${css[item.severity]} ${item.transient ? css.transientCard : ''}`}
        >
          <span className={css.chipBadge}>{item.badge}</span>
          <span className={css.chipTitle}>{item.chipTitle ?? item.title}</span>
          {(item.status || item.short) && <span className={css.chipShort}>{item.status ?? item.short}</span>}
          {item.dismissible && item.onDismiss && (
            <button className={css.chipDismiss} onClick={dismissOf(item)} aria-label="Dismiss">✕</button>
          )}
        </div>
      ))}
      {overflow > 0 && (
        <div className={css.overflow}>+{overflow} more</div>
      )}
    </div>
  )
}
