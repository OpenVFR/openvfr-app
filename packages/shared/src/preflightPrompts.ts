/**
 * Pre-flight prompts: reminders shown beside (not among) the route warnings.
 * They are informational, never a problem with the route itself, so they do
 * not turn the "No issues found" line off. Pure and shared by web and native.
 *
 *   - winds-unavailable: some leg has no wind, so ETE/fuel assume still air there
 *   - flightplan-likely: the route appears to cross an international boundary
 *   - gar-uk: a flight between the UK and another country (UK-only notice)
 */

import { EUROPEAN_REGIONS } from './regions'
import { REGION_ICAO_PREFIXES } from './notamRelevance'
import type { RouteWaypoint } from './types'

export interface PreflightPrompt {
  code:   string
  title:  string
  detail: string
}

export interface PromptInput {
  waypoints: RouteWaypoint[]
  /** Effective wind per leg; null where none is known. Omit to skip the winds prompt. */
  legWinds?: ({ dirDeg: number; speedKts: number } | null)[]
  /** Forecast still loading: the winds prompt waits for it. */
  windsLoading?: boolean
}

/**
 * The one region whose bounding box contains the point. Boxes overlap near
 * borders, so a point in an overlap (or outside every box) is "unknown"
 * (null): a prompt must not guess a border crossing from that.
 */
export function unambiguousRegion(p: { lat: number; lng: number }): string | null {
  let found: string | null = null
  for (const r of EUROPEAN_REGIONS) {
    const [s, w, n, e] = r.bbox
    if (p.lat >= s && p.lat <= n && p.lng >= w && p.lng <= e) {
      if (found) return null
      found = r.code
    }
  }
  return found
}

/**
 * Country of an aerodrome waypoint from its ICAO location indicator
 * (four letters, e.g. ESSA). null for other names or a prefix shared by
 * two countries.
 */
export function regionFromIcao(name: string | undefined): string | null {
  if (!name || !/^[A-Z]{4}$/.test(name)) return null
  const hits = Object.entries(REGION_ICAO_PREFIXES)
    .filter(([, prefixes]) => prefixes.some((p) => name.startsWith(p)))
    .map(([code]) => code)
  return hits.length === 1 ? hits[0] : null
}

/**
 * Distinct countries the route's waypoints are in, in route order. An
 * aerodrome's ICAO prefix decides first (exact); otherwise the position
 * must fall in exactly one region box. Unknown points are left out, so the
 * result can miss a crossing but never invents one.
 */
export function routeCountries(waypoints: RouteWaypoint[]): string[] {
  const out: string[] = []
  for (const w of waypoints) {
    const c = regionFromIcao(w.name) ?? unambiguousRegion(w)
    if (c && !out.includes(c)) out.push(c)
  }
  return out
}

export function computePrompts(input: PromptInput): PreflightPrompt[] {
  const { waypoints, legWinds, windsLoading } = input
  const prompts: PreflightPrompt[] = []
  if (waypoints.length < 2) return prompts

  if (legWinds && !windsLoading) {
    const missing = legWinds.filter((w) => w == null).length
    if (missing > 0) {
      prompts.push({
        code:   'winds-unavailable',
        title:  'Wind data unavailable',
        detail: missing === legWinds.length
          ? 'No wind is known for this route, so time and fuel assume still air. Enter a wind or refresh the forecast.'
          : `No wind is known for ${missing} of ${legWinds.length} legs; time and fuel assume still air on those.`,
      })
    }
  }

  const countries = routeCountries(waypoints)
  if (countries.length > 1) {
    prompts.push({
      code:   'flightplan-likely',
      title:  'Route crosses a national border',
      detail: 'A flight plan may be required for a flight between these countries. Check the national rules for each.',
    })
    if (countries.includes('gb')) {
      prompts.push({
        code:   'gar-uk',
        title:  'UK General Aviation Report',
        detail: 'Flights between the UK and another country normally need a General Aviation Report filed in advance. Check the deadline and where to submit it.',
      })
    }
  }

  return prompts
}
