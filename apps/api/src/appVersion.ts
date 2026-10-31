/**
 * Force-update gate for the native apps -- GET /api/version.
 *
 * Two floors, both reported by /api/version:
 *   - `minVersion` (APP_MIN_VERSION, semver): read by app builds from before
 *     build-number support. Kept for them; newer builds check it too.
 *   - `minBuild` per platform: the lowest Android versionCode / iOS
 *     CFBundleVersion still allowed. Set from the admin dashboard
 *     (app_min_build table, see db/migrations/20261120000000_app_min_build.sql);
 *     without a row, the APP_MIN_BUILD_ANDROID / APP_MIN_BUILD_IOS env default
 *     (unset = 0 = no minimum).
 *
 * A native app below its platform's floor shows a blocking "Update required"
 * page (apps/native/src/hooks/useForceUpdate.ts).
 *
 * The apps pass their own platform and build number as query parameters. The
 * api counts launches per build in memory (no user, no IP; reset on restart),
 * so the dashboard can show how many launches a new minimum would block.
 */
// db.js is loaded on first use: it needs DATABASE_URL, and the pure helpers
// here are unit-tested without one.
const db = () => import('./db.js').then(m => m.pool)

export const APP_PLATFORMS = ['android', 'ios'] as const
export type AppPlatform = typeof APP_PLATFORMS[number]
export type MinBuilds = Record<AppPlatform, number>

/** Highest build number accepted anywhere (Android versionCode limit). */
export const MAX_BUILD = 2_100_000_000
const CACHE_MS = 60_000
/** Distinct builds counted per platform; older ones are dropped first. */
const MAX_SEEN_BUILDS = 50

export const isAppPlatform = (v: unknown): v is AppPlatform =>
  typeof v === 'string' && (APP_PLATFORMS as readonly string[]).includes(v)

/** A build number from a query string / JSON body; null when not a whole number in range. */
export function parseBuild(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,10}$/.test(v.trim()) ? Number(v.trim()) : NaN
  return Number.isInteger(n) && n >= 0 && n <= MAX_BUILD ? n : null
}

export function envMinBuilds(env: Record<string, string | undefined> = process.env): MinBuilds {
  return {
    android: parseBuild(env['APP_MIN_BUILD_ANDROID'] ?? '0') ?? 0,
    ios:     parseBuild(env['APP_MIN_BUILD_IOS'] ?? '0') ?? 0,
  }
}

export const MIN_VERSION = process.env['APP_MIN_VERSION'] ?? '0.0.0'

// ── Stored minimums ─────────────────────────────────────────────────────────

export interface MinBuildRow { platform: AppPlatform; minBuild: number; updatedAt: string; updatedBy: string | null }

let cached: { rows: MinBuildRow[]; at: number } | null = null
let inFlight: Promise<MinBuildRow[] | null> | null = null

async function loadRows(): Promise<MinBuildRow[] | null> {
  try {
    const { rows } = await (await db()).query<{ platform: string; min_build: number; updated_at: Date; updated_by: string | null }>(
      'SELECT platform, min_build, updated_at, updated_by FROM app_min_build',
    )
    const out = rows.filter(r => isAppPlatform(r.platform)).map(r => ({
      platform: r.platform as AppPlatform, minBuild: r.min_build,
      updatedAt: new Date(r.updated_at).toISOString(), updatedBy: r.updated_by,
    }))
    cached = { rows: out, at: Date.now() }
    return out
  } catch (e) {
    // Keep serving the last known numbers (or the env defaults): a database
    // hiccup must not lift a minimum, nor fail /api/version.
    console.warn('[app-version] min build read failed:', (e as Error).message)
    return cached?.rows ?? null
  }
}

/** Stored rows (cached CACHE_MS); null when never readable. */
export async function minBuildRows(): Promise<MinBuildRow[] | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.rows
  inFlight ??= loadRows().finally(() => { inFlight = null })
  return inFlight
}

/** Effective minimum per platform: the stored value, else the env default. */
export function effectiveMinBuilds(rows: MinBuildRow[] | null, env: MinBuilds = envMinBuilds()): MinBuilds {
  const out = { ...env }
  for (const r of rows ?? []) out[r.platform] = r.minBuild
  return out
}

export async function setMinBuild(platform: AppPlatform, minBuild: number, by: string): Promise<void> {
  await (await db()).query(`
    INSERT INTO app_min_build (platform, min_build, updated_at, updated_by)
    VALUES ($1, $2, now(), $3)
    ON CONFLICT (platform) DO UPDATE SET
      min_build = EXCLUDED.min_build, updated_at = now(), updated_by = EXCLUDED.updated_by
  `, [platform, minBuild, by])
  cached = null
}

// ── Builds seen (in memory) ─────────────────────────────────────────────────

const seenSince = new Date().toISOString()
const seen: Record<AppPlatform, Map<number, { launches: number; lastSeen: number }>> = { android: new Map(), ios: new Map() }

export function recordLaunch(platform: AppPlatform, build: number, now = Date.now()): void {
  const m = seen[platform]
  const e = m.get(build)
  if (e) { e.launches++; e.lastSeen = now; return }
  if (m.size >= MAX_SEEN_BUILDS) {
    // Drop the build seen least recently: junk numbers can't push out real ones for long.
    let oldest: number | null = null
    for (const [b, v] of m) if (oldest === null || v.lastSeen < m.get(oldest)!.lastSeen) oldest = b
    if (oldest !== null) m.delete(oldest)
  }
  m.set(build, { launches: 1, lastSeen: now })
}

export interface SeenBuild { build: number; launches: number; lastSeen: string }

export function seenBuilds(): { since: string } & Record<AppPlatform, SeenBuild[]> {
  const list = (p: AppPlatform) => [...seen[p]]
    .map(([build, v]) => ({ build, launches: v.launches, lastSeen: new Date(v.lastSeen).toISOString() }))
    .sort((a, b) => b.build - a.build)
  return { since: seenSince, android: list('android'), ios: list('ios') }
}

/** For tests. */
export function resetSeenBuilds(): void {
  seen.android.clear(); seen.ios.clear()
}
