/**
 * airspaceInForce -- areas the data pipeline added from an AIP supplement (`source === "sup"`, openvfr-infra
 * `sup_airspace_ext.py`) carry `active_until`, the end of the supplement's validity (UTC, "2026-11-10T23:59Z").
 * The pipeline drops ended areas on its daily run, but a client keeps its copy for longer (cache, offline
 * download), so warnings, alerts, the vertical profile and tap results skip an area whose time has passed.
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
