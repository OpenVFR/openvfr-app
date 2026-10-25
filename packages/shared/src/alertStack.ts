/**
 * Layout of the in-flight alert stack: which items get a full card and which
 * collapse into a one-line chip.
 *
 * A stack of equally loud cards hides the map and teaches the pilot to ignore
 * all of them. So:
 *   - red alerts always get a full card (never hidden);
 *   - yellow alerts and notes share the remaining card slots (default 2 total),
 *     alerts first;
 *   - events (entered/left an airspace, ceiling filter), blue advisories and
 *     everything that did not fit become one-line chips;
 *   - only a few chips are listed, the rest is a "+N more" count.
 */

export type AlertSeverity = 'red' | 'yellow' | 'blue'
/** alert: a hazard that persists while true. event: something that happened.
 *  note: pilot-authored or planning text. */
export type AlertTier = 'alert' | 'event' | 'note'

export const MAX_ALERT_CARDS = 2
export const MAX_ALERT_CHIPS = 4

const SEVERITY_ORDER: Record<AlertSeverity, number> = { red: 0, yellow: 1, blue: 2 }

export type StackLayout<T> = { cards: T[]; chips: T[]; overflow: number }

export function layoutAlertStack<T extends { severity: AlertSeverity; tier: AlertTier }>(
  items: readonly T[],
  maxCards: number = MAX_ALERT_CARDS,
  maxChips: number = MAX_ALERT_CHIPS,
): StackLayout<T> {
  // Array#sort is stable: equal severity keeps the order the caller gave.
  const sorted = [...items].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  const cardSet = new Set<T>()
  for (const it of sorted) if (it.tier === 'alert' && it.severity === 'red') cardSet.add(it)
  for (const tier of ['alert', 'note'] as const) {
    for (const it of sorted) {
      if (cardSet.size >= maxCards) break
      if (it.tier !== tier || cardSet.has(it)) continue
      if (it.severity === 'blue') continue
      cardSet.add(it)
    }
  }
  const cards = sorted.filter(it => cardSet.has(it))
  const rest  = sorted.filter(it => !cardSet.has(it))
  return { cards, chips: rest.slice(0, maxChips), overflow: Math.max(0, rest.length - maxChips) }
}
