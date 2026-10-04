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
import type { AirspaceAlert } from '../hooks/useAirspaceWarnings'
import type { AirspaceNotification } from '../hooks/useAirspaceNotifications'
import type { ObstructionAlert } from '../hooks/useObstructionWarnings'
import type { AirfieldProximityAlert } from '../hooks/useAirfieldProximity'
import type { NotamAlert } from '../hooks/useNotamWarnings'
import type { NotamNotification } from '../hooks/useNotamNotifications'
import css from './NotificationCenter.module.css'

type Severity = 'red' | 'yellow' | 'blue'

interface Item {
  key:         string
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

const SEVERITY_ORDER: Record<Severity, number> = { red: 0, yellow: 1, blue: 2 }

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

const OBSTRUCTION_KIND_LABEL: Record<string, string> = {
  wind_turbine: '⟳ WIND TURBINE',
  tower:        '▲ TOWER',
  chimney:      '▲ CHIMNEY',
  building:     '▣ BUILDING',
  other:        '▲ OBSTACLE',
}

const MAX_VISIBLE = 5
const AUTO_DISMISS_MS = 30_000

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
}: Props) {
  // Waypoint reminder auto-dismisses after 30s.
  useEffect(() => {
    if (!reminderNote || !onDismissReminder) return
    const id = setTimeout(onDismissReminder, AUTO_DISMISS_MS)
    return () => clearTimeout(id)
  }, [reminderNote, onDismissReminder])

  const items: Item[] = []

  // One card per airspace: the newest transition toast (entered/left) wins
  // over the persistent alert for the same airspace; among toasts the latest
  // expiry wins; among alerts the first (inside sorts before ahead/vertical) wins.
  const airspaceId = (name: string, cls: string) => `${name}::${cls}`
  const latestNotif = new Map<string, AirspaceNotification>()
  for (const n of latestNotif.values()) {
    const id = airspaceId(n.name, n.cls)
    const cur = latestNotif.get(id)
    if (!cur || n.expiresAt >= cur.expiresAt) latestNotif.set(id, n)
  }
  const seenAlert = new Set<string>()
  const shownAlerts = airspaceAlerts.filter(a => {
    const id = airspaceId(a.name, a.cls)
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

  for (const a of obstructionAlerts) {
    items.push({
      key: `ob-${a.key}`,
      severity: 'yellow',
      badge: OBSTRUCTION_KIND_LABEL[a.kind] ?? '▲ OBSTACLE',
      title: a.name || a.kind.replace('_', ' '),
      meta: `${a.tipFt > a.elevationFt ? `Top ${a.tipFt} ft · base ${a.elevationFt} ft AMSL` : `${a.elevationFt} ft AMSL`} · ${a.distNm < 0.1 ? '<0.1' : a.distNm.toFixed(1)} NM`,
      dismissible: true,
      onDismiss: () => onDismissObstruction(a.key),
    })
  }

  for (const a of airfieldAlerts) {
    items.push({
      key: `af-${a.key}`,
      severity: 'blue',
      badge: '✈ AERODROME NEARBY',
      title: `${a.icao ? `${a.icao} — ` : ''}${a.name}`,
      meta: `${a.distNm.toFixed(1)} NM · elev ${a.elevationFt} ft${a.primaryFreq ? ` · ${a.primaryFreq} MHz` : ''}`,
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

  for (const n of airspaceNotifications) {
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

  if (items.length === 0) return null

  items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  const visible = items.slice(0, MAX_VISIBLE)
  const overflow = items.length - MAX_VISIBLE

  return (
    <div className={css.container} role="alert" aria-live="assertive">
      {visible.map(item => (
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
                onClick={item.onDismiss}
                aria-label="Dismiss"
              >✕</button>
            )}
          </div>
          <div className={css.title}>{item.title}</div>
          {item.meta && <div className={css.meta}>{item.meta}</div>}
          {item.text && <div className={css.text}>{item.text}</div>}
        </div>
      ))}
      {overflow > 0 && (
        <div className={css.overflow}>+{overflow} more</div>
      )}
    </div>
  )
}
