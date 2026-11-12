/**
 * MCP tools for the logbook (scope logs:read): flight summaries and totals.
 * Never positions or GPS tracks (see logbook.ts and the briefingData query).
 */
import * as z from 'zod'
import { QUOTE_NOTE } from './untrusted'
import { flightLine, summaryLines } from './logbook'
import { DAY_MS, fail, text, type Ctx } from './mcpContext'

const LOG_NOTE = 'From the pilot\'s OpenVFR logbook: only flights recorded or imported there. Counts logged flights, not take-offs and landings: licence currency and medical rules are for the pilot and the authority to judge.'

export function registerLogbookTools(c: Ctx): void {
  const { deps, caller } = c

  c.tool('list_flights', {
    description: "The pilot's logged flights, newest first: date, aircraft registration, departure and arrival aerodrome, flight time, distance and highest altitude. No positions or GPS tracks.",
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      from: z.string().max(10).optional().describe('Earliest date, YYYY-MM-DD'),
      to: z.string().max(10).optional().describe('Latest date, YYYY-MM-DD'),
      aircraft: z.string().max(40).optional().describe('Registration'),
      limit: z.number().int().min(1).max(50).optional().describe('Default 20'),
    }),
  }, async ({ from, to, aircraft, limit }) => {
    if (!c.canLogs) return c.noLogs()
    const day = (v: string | undefined) => (v === undefined ? undefined : /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null)
    const f = day(from), t = day(to)
    if (f === null || t === null) return fail('Dates must be YYYY-MM-DD.')
    let list = await deps.flights(caller.userId)
    if (f !== undefined) list = list.filter(x => x.endedAt >= f)
    if (t !== undefined) list = list.filter(x => x.endedAt < t + DAY_MS)
    if (aircraft) list = list.filter(x => x.registration.toLowerCase() === aircraft.trim().toLowerCase())
    if (list.length === 0) return text('No logged flights match.')
    const n = limit ?? 20
    return text(`${list.length} logged flight${list.length === 1 ? '' : 's'}, newest first:\n${list.slice(0, n).map(flightLine).join('\n')}${list.length > n ? `\n… ${list.length - n} more: narrow with from/to/aircraft or raise limit.` : ''}\n${LOG_NOTE}\n${QUOTE_NOTE}`)
  })

  c.tool('logbook_summary', {
    description: "Totals from the pilot's logbook: last flight, flights and hours in the last 30 days, 90 days and 12 months, and per aircraft. Use it for how current or recent the pilot is.",
    annotations: { readOnlyHint: true },
    inputSchema: z.object({}),
  }, async () => {
    if (!c.canLogs) return c.noLogs()
    const list = await deps.flights(caller.userId)
    return text(`${summaryLines(list, Date.now(), list.length >= 1000).join('\n')}\n${LOG_NOTE}\n${QUOTE_NOTE}`)
  })
}
