/**
 * Per-category alert level for look-ahead airspace warnings.
 *
 *   alert  - full warning (red or yellow, by category)
 *   info   - quiet: a one-line blue chip, no card
 *   ignore - no look-ahead warning at all
 *
 * Entered / left notices are separate (their own on/off setting). Categories
 * that are dangerous to miss (restricted areas, class A) can be quietened to
 * `info` but never ignored.
 */

export type AirspaceCategory = 'restricted' | 'classA' | 'controlled' | 'classEF' | 'zones' | 'activity'
export type AlertLevel = 'alert' | 'info' | 'ignore'
export type AirspaceAlertLevels = Record<AirspaceCategory, AlertLevel>

export const AIRSPACE_CATEGORIES: ReadonlyArray<{ key: AirspaceCategory; label: string; canIgnore: boolean }> = [
  { key: 'restricted', label: 'Restricted / danger / TRA', canIgnore: false },
  { key: 'classA',     label: 'Class A',                   canIgnore: false },
  { key: 'controlled', label: 'Class B / C / D, CTR, TMA', canIgnore: true },
  { key: 'classEF',    label: 'Class E / F',               canIgnore: true },
  { key: 'zones',      label: 'ATZ / RMZ / TMZ',           canIgnore: true },
  { key: 'activity',   label: 'Glider / model / other',    canIgnore: true },
]

export const DEFAULT_AIRSPACE_LEVELS: AirspaceAlertLevels = {
  restricted: 'alert',
  classA:     'alert',
  controlled: 'alert',
  classEF:    'ignore',
  zones:      'info',
  activity:   'info',
}

const LEVELS: readonly AlertLevel[] = ['alert', 'info', 'ignore']

/** Category of an airspace from its display class and type. */
export function airspaceCategory(cls: string, type: string): AirspaceCategory {
  if (cls === 'R' || cls === 'TRA') return 'restricted'
  if (cls === 'A') return 'classA'
  if (cls === 'B' || cls === 'C' || cls === 'D') return 'controlled'
  if (cls === 'E' || cls === 'F') return 'classEF'
  if (['ATZ', 'RMZ', 'TMZ'].includes(cls) || ['ATZ', 'RMZ', 'TMZ'].includes(type)) return 'zones'
  return 'activity'
}

/** Fill gaps with defaults and refuse `ignore` where it is not allowed. */
export function resolveAirspaceLevels(raw?: Partial<Record<string, unknown>> | null): AirspaceAlertLevels {
  const out = { ...DEFAULT_AIRSPACE_LEVELS }
  for (const c of AIRSPACE_CATEGORIES) {
    const v = raw?.[c.key]
    if (typeof v === 'string' && (LEVELS as readonly string[]).includes(v)) out[c.key] = v as AlertLevel
    if (!c.canIgnore && out[c.key] === 'ignore') out[c.key] = 'info'
  }
  return out
}

const ALERT_SEVERITY: Record<AirspaceCategory, 'red' | 'yellow'> = {
  restricted: 'red', classA: 'red', controlled: 'yellow', classEF: 'yellow', zones: 'yellow', activity: 'yellow',
}

/** The alert with its severity set by the category's level, or null to drop it. */
export function applyAirspaceLevel<T extends { cls: string; type: string; severity: 'red' | 'yellow' | 'blue' }>(
  alert: T,
  levels: AirspaceAlertLevels,
): T | null {
  const cat = airspaceCategory(alert.cls, alert.type)
  const level = levels[cat]
  if (level === 'ignore') return null
  return { ...alert, severity: level === 'info' ? 'blue' : ALERT_SEVERITY[cat] }
}
