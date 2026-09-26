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
