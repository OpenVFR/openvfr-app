/**
 * pprMode -- prior permission to land, in four states instead of a yes/no.
 *
 * No source defines PPR as a boolean: an AIP states it as text ("PPR outside TWR hours",
 * "PPR for IFR school flights", "PPR 1 OCT-30 APR"), and open data sets carry flags that
 * only mean "restricted use". The aerodrome data therefore carries `ppr_mode` beside the
 * older `ppr` boolean:
 *
 *   always       every visitor needs prior permission
 *   conditional  permission is needed only for some traffic, hours, seasons or activities
 *                (the sentence is in `ppr_remarks`)
 *   none         reviewed: no PPR
 *   unknown      nothing is known (a data set's "false" is no information)
 *
 * Data without `ppr_mode` (an older file) falls back to the boolean: true is `always`,
 * anything else is `unknown`, so nothing is shown that was not shown before.
 */
export type PprMode = 'always' | 'conditional' | 'none' | 'unknown'

const MODES: readonly string[] = ['always', 'conditional', 'none', 'unknown']

export function pprModeOf(p: { ppr?: unknown; ppr_mode?: unknown } | null | undefined): PprMode {
  const m = p?.ppr_mode
  if (typeof m === 'string' && MODES.includes(m)) return m as PprMode
  return p?.ppr === true ? 'always' : 'unknown'
}

/** The short badge text, or null when nothing is to be shown ("PPR" or "PPR*" for conditions). */
export function pprBadge(mode: PprMode): string | null {
  return mode === 'always' ? 'PPR' : mode === 'conditional' ? 'PPR*' : null
}

/** The sentence behind the badge (tooltip, accessibility label). */
export function pprExplain(mode: PprMode): string {
  return mode === 'always' ? 'Prior permission required'
    : mode === 'conditional' ? 'Prior permission required in some cases (traffic, hours or season): see the remarks'
    : mode === 'none' ? 'No prior permission required' : 'Prior permission: no information'
}
