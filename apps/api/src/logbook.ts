/**
 * Summaries of the pilot's logged flights for the assistant (list_flights,
 * logbook_summary): durations, totals per period and aircraft, without I/O.
 * Never positions: the callers only hold the per-flight summary, no track.
 */
import type { FlightSummary } from './briefingData'
import { quote } from './untrusted'

const DAY = 86_400_000

/** Flight time in minutes, null when the log has no start time. */
export function durationMin(f: FlightSummary): number | null {
  return f.startedAt > 0 && f.endedAt > f.startedAt ? Math.round((f.endedAt - f.startedAt) / 60_000) : null
}

export const hm = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`

export function flightLine(f: FlightSummary): string {
  const d = durationMin(f)
  const route = [f.departure, f.arrival].map(x => (x ? quote(x, 20) : '?')).join(' → ')
  return `- ${new Date(f.endedAt).toISOString().slice(0, 10)} ${f.registration ? quote(f.registration, 20) : 'no aircraft'} ${route}, ${d === null ? 'time unknown' : `${hm(d)} h`}, ${Math.round(f.distanceNm)} NM, max ${f.maxAltFt} ft`
}

export interface Totals { flights: number; minutes: number; unknownTime: number; nm: number }

export function totals(fs: readonly FlightSummary[]): Totals {
  const t: Totals = { flights: fs.length, minutes: 0, unknownTime: 0, nm: 0 }
  for (const f of fs) {
    const d = durationMin(f)
    if (d === null) t.unknownTime++; else t.minutes += d
    t.nm += f.distanceNm
  }
  return t
}

const totalsText = (t: Totals) =>
  `${t.flights} flight${t.flights === 1 ? '' : 's'}, ${hm(t.minutes)} h, ${Math.round(t.nm)} NM${t.unknownTime ? ` (${t.unknownTime} without a start time, not in the hours)` : ''}`

/** Totals for the last 30 and 90 days, 12 months and all logged flights, per aircraft over 12 months. */
export function summaryLines(fs: readonly FlightSummary[], now: number, capped: boolean): string[] {
  if (fs.length === 0) return ['No flights in the logbook.']
  const since = (days: number) => fs.filter(f => f.endedAt >= now - days * DAY)
  const last = fs[0]!
  const lines = [
    `Last flight: ${new Date(last.endedAt).toISOString().slice(0, 10)} (${Math.floor((now - last.endedAt) / DAY)} days ago).`,
    `Last 30 days: ${totalsText(totals(since(30)))}`,
    `Last 90 days: ${totalsText(totals(since(90)))}`,
    `Last 12 months: ${totalsText(totals(since(365)))}`,
    `${capped ? 'Latest logged flights' : 'All logged flights'}: ${totalsText(totals(fs))}`,
  ]
  const per = new Map<string, FlightSummary[]>()
  for (const f of since(365)) { const k = f.registration || 'no aircraft'; per.set(k, [...(per.get(k) ?? []), f]) }
  if (per.size > 0) {
    lines.push('Last 12 months per aircraft:')
    for (const [reg, l] of [...per].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) lines.push(`- ${quote(reg, 20)}: ${totalsText(totals(l))}`)
  }
  return lines
}
