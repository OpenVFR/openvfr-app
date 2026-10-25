/**
 * Several airspaces of the same kind (stacked sectors, a CTR inside a TMA)
 * are one situation: one card listing them beats one card each.
 */

export type SummarizableAirspace = {
  key: string
  name: string
  lower: string
  upper: string
  inside: boolean
}

export type AirspaceSummary = {
  count: number
  anyInside: boolean
  /** "NAME · NAME" for the title. */
  title: string
  /** One line per airspace: "NAME  lower – upper". */
  lines: string[]
  keys: string[]
}

export function summarizeAirspaceAlerts(alerts: readonly SummarizableAirspace[]): AirspaceSummary | null {
  if (alerts.length === 0) return null
  return {
    count: alerts.length,
    anyInside: alerts.some(a => a.inside),
    title: alerts.map(a => a.name).join(' \u00b7 '),
    lines: alerts.map(a => `${a.name}  ${a.lower} \u2013 ${a.upper}`),
    keys: alerts.map(a => a.key),
  }
}
