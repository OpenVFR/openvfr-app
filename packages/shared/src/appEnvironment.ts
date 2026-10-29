/**
 * Which backend the native app talks to: the default ("production") one or
 * an optional second ("staging") one configured at build time.
 *
 * The list is fixed (two allow-listed environments, URLs baked in at build
 * time) -- never a free-text server URL, so nobody can talk a user into
 * pointing the app at their own server. Pure helpers here; the native app
 * stores the choice and applies it at startup (apps/native/src/environment.ts).
 */

export type AppEnvironmentId = 'production' | 'staging'

export const APP_ENVIRONMENT_IDS: readonly AppEnvironmentId[] = ['production', 'staging']

export function isAppEnvironmentId(value: unknown): value is AppEnvironmentId {
  return value === 'production' || value === 'staging'
}

export function appEnvironmentLabel(id: AppEnvironmentId): string {
  return id === 'staging' ? 'Staging' : 'Production'
}

/**
 * The environment to run with: the saved choice when it is still possible,
 * else the build's default, else production. `stagingAvailable` is false in
 * builds without a staging api configured (self-hosted builds, forks).
 */
export function resolveAppEnvironment(opts: {
  saved: unknown
  buildDefault: unknown
  stagingAvailable: boolean
}): AppEnvironmentId {
  const usable = (v: unknown): v is AppEnvironmentId =>
    isAppEnvironmentId(v) && (v === 'production' || opts.stagingAvailable)
  if (usable(opts.saved)) return opts.saved
  if (usable(opts.buildDefault)) return opts.buildDefault
  return 'production'
}

/**
 * Environment switch deep link: `<scheme>://environment/<id>`, e.g.
 * `openvfr://environment/staging`. Returns null for any other URL (including
 * unknown environment names), so callers can ignore everything else.
 */
export function parseEnvironmentLink(url: string | null | undefined, scheme = 'openvfr'): AppEnvironmentId | null {
  if (!url) return null
  const prefix = `${scheme.toLowerCase()}://environment/`
  if (!url.toLowerCase().startsWith(prefix)) return null
  const id = url.slice(prefix.length).split(/[/?#]/)[0]?.toLowerCase()
  return isAppEnvironmentId(id) ? id : null
}
