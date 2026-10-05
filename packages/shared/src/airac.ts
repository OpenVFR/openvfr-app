/**
 * AIRAC cycle arithmetic (ICAO Annex 15 / Doc 8126): cycles are exactly 28
 * days apart, anchored to a known effective date. Identifier "YYNN" = year +
 * 1-based ordinal of the cycle's effective date within that calendar year.
 * Most years have 13 cycles, some have 14 (e.g. 2020: cycle 2014 effective
 * 2020-12-31) -- so the ordinal must be derived from the effective date's own
 * year, never as `index % 13`.
 *
 * Anchor: cycle 2501 effective 2025-01-23 (ICAO/Eurocontrol published table).
 */

const DAY_MS = 86_400_000
const CYCLE_MS = 28 * DAY_MS
const ANCHOR_MS = Date.UTC(2025, 0, 23)

/** Effective date (ms, 00:00Z) of the cycle in force at `now`. */
export function airacEffectiveMs(now: number = Date.now()): number {
  const n = Math.floor((now - ANCHOR_MS) / CYCLE_MS)
  return ANCHOR_MS + n * CYCLE_MS
}

function identForEffective(effMs: number): string {
  const year = new Date(effMs).getUTCFullYear()
  const ordinal = Math.floor((effMs - Date.UTC(year, 0, 1)) / CYCLE_MS) + 1
  return `${String(year % 100).padStart(2, '0')}${String(ordinal).padStart(2, '0')}`
}

/** Identifier of the cycle in force at `now`, e.g. "2506". */
export function currentAiracCycle(now: number = Date.now()): string {
  return identForEffective(airacEffectiveMs(now))
}

/** Effective date (ms) of identifier "YYNN", or null if malformed/nonexistent. */
export function airacIdentToMs(ident: string): number | null {
  const m = /^(\d{2})(\d{2})$/.exec(ident.trim())
  if (!m) return null
  const year = 2000 + parseInt(m[1], 10)
  const ordinal = parseInt(m[2], 10)
  if (ordinal < 1) return null
  // First cycle effective on/after Jan 1 of that year.
  const jan1 = Date.UTC(year, 0, 1)
  const first = ANCHOR_MS + Math.ceil((jan1 - ANCHOR_MS) / CYCLE_MS) * CYCLE_MS
  const eff = first + (ordinal - 1) * CYCLE_MS
  return new Date(eff).getUTCFullYear() === year ? eff : null
}

/**
 * True when `dataCycle` is older than the cycle in force at `now`. A cycle
 * NEWER than current (data published ahead of its effective date, which
 * AIRAC's publication lead time routinely produces) is not outdated. An
 * unparseable identifier returns false -- unknown, not provably stale.
 */
export function isAiracOutdated(dataCycle: string, now: number = Date.now()): boolean {
  const ms = airacIdentToMs(dataCycle)
  return ms !== null && ms < airacEffectiveMs(now)
}

/**
 * Airspace datasets in a tile manifest whose AIRAC cycle has been superseded.
 * Airspace is the AIRAC-governed dataset that matters for a go/no-go; other
 * datasets (obstacles, landuse) refresh on their own cadence without a cycle.
 * Structural type so this module stays free of a tileManifest import.
 */
export function findOutdatedAirac(
  manifest: { countries?: Record<string, Record<string, { airac_cycle?: string } | undefined>> } | null,
  now: number = Date.now(),
): { country: string; cycle: string }[] {
  if (!manifest) return []
  return Object.entries(manifest.countries ?? {})
    .flatMap(([country, ds]) => {
      const cycle = ds['airspace']?.airac_cycle
      return cycle && isAiracOutdated(cycle, now) ? [{ country, cycle }] : []
    })
    .sort((a, b) => a.country.localeCompare(b.country))
}

/** Identifier of the cycle effective at `effMs` (exported for UI "next cycle"). */
export function airacIdentForEffective(effMs: number): string {
  return identForEffective(effMs)
}

/**
 * Everything a "is my aviation data current?" panel needs, in one place:
 * which cycle the data is, the window it is valid for, whether a newer cycle
 * is already in force, and when the next one starts.
 *
 * `state`:
 *  - 'current'  the data's cycle is the one in force, or a newer one
 *               (published ahead of its effective date);
 *  - 'outdated' a newer cycle is in force -- the data may show superseded
 *               airspace;
 *  - 'unknown'  no cycle reported (manifest missing it, or unparseable).
 *               Shown as a caution, never as "current": the absence of a
 *               cycle is how a silently stalled pipeline looks.
 */
export type AiracDataStatus = {
  state:           'current' | 'outdated' | 'unknown'
  cycle:           string | null
  /** Effective date of the data's cycle, and of the cycle after it (exclusive end). */
  validFromMs:     number | null
  validToMs:       number | null
  inForceCycle:    string
  inForceSinceMs:  number
  nextCycle:       string
  nextEffectiveMs: number
}

export function airacDataStatus(cycle: string | null | undefined, now: number = Date.now()): AiracDataStatus {
  const inForceSinceMs  = airacEffectiveMs(now)
  const nextEffectiveMs = inForceSinceMs + CYCLE_MS
  const base = {
    inForceCycle:    identForEffective(inForceSinceMs),
    inForceSinceMs,
    nextCycle:       identForEffective(nextEffectiveMs),
    nextEffectiveMs,
  }
  const validFromMs = cycle ? airacIdentToMs(cycle) : null
  if (!cycle || validFromMs == null) {
    return { ...base, state: 'unknown', cycle: cycle ?? null, validFromMs: null, validToMs: null }
  }
  return {
    ...base,
    state:     validFromMs < inForceSinceMs ? 'outdated' : 'current',
    cycle,
    validFromMs,
    validToMs: validFromMs + CYCLE_MS,
  }
}

/** "just now", "5 minutes ago", "3 hours ago", "4 days ago"; future → "in 4 days". */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const d = ms - now
  const a = Math.abs(d)
  const unit = a < 60_000 ? null
    : a < 3_600_000 ? ['minute', 60_000] as const
    : a < DAY_MS ? ['hour', 3_600_000] as const
    : ['day', DAY_MS] as const
  if (!unit) return 'just now'
  const n = Math.round(a / unit[1])
  const s = `${n} ${unit[0]}${n === 1 ? '' : 's'}`
  return d < 0 ? `${s} ago` : `in ${s}`
}
