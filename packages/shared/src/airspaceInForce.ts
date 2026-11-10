/**
 * airspaceInForce -- the data pipeline adds areas that an AIP supplement established in the middle of an AIRAC
 * cycle to the airspace file, marked `source: "sup"` with `active_until`, the end of the supplement's validity
 * (UTC, "2026-11-10T23:59Z"). The pipeline drops ended areas on its daily run, but a client keeps its copy for
 * longer (cache, offline download), so warnings, alerts, the vertical profile and tap results skip an area whose
 * time has passed.
 *
 * Callers that build a list once per data load (the alert hooks) judge it at load time: an area that ends during
 * a long session keeps alerting until the data reloads. That errs towards warning and is deliberate; tap results
 * are judged per tap.
 *
 * Only `source === "sup"` is judged: other `active_*` fields (OpenAIP gap-fill) mean something else and an
 * area without any of this is always in force. A start date in the future is NOT hidden: planning ahead
 * should still show and warn about it.
 */
export function airspaceEnded(props: unknown, nowMs: number = Date.now()): boolean {
  const p = props as { source?: unknown; active_until?: unknown } | null | undefined
  if (!p || p.source !== 'sup' || typeof p.active_until !== 'string') return false
  const end = Date.parse(p.active_until)
  return Number.isFinite(end) && end < nowMs
}
