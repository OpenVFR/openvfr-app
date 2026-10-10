/**
 * Optional Cloudflare Access gate for the admin API.
 *
 * When CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are both set, every
 * /api/admin/* request must carry a valid `Cf-Access-Jwt-Assertion` header
 * (added by Cloudflare's edge after the Access login), and the token's email
 * must match the signed-in admin. Verified here, in the api, so an Access
 * misconfiguration or any path that reaches the api without passing the edge
 * does not bypass it.
 *
 * Both unset = feature off (self-hosters without Access are unaffected).
 * Exactly one set = startup error.
 */

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

export interface AccessConfig {
  /** e.g. https://myteam.cloudflareaccess.com -- used as the JWT issuer. */
  issuer: string
  /** Application Audience (AUD) tag from the Access application. */
  aud: string
}

export function accessConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AccessConfig | null {
  const team = env['CF_ACCESS_TEAM_DOMAIN']?.trim() || ''
  const aud  = env['CF_ACCESS_AUD']?.trim() || ''
  if (!team && !aud) return null
  if (!team || !aud) {
    throw new Error('CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must both be set, or both left unset')
  }
  const issuer = (team.startsWith('https://') ? team : `https://${team}`).replace(/\/+$/, '')
  return { issuer, aud }
}

export type AccessResult = { ok: true } | { ok: false; reason: string }

export type AccessVerifier = (token: string | undefined, expectedEmail: string) => Promise<AccessResult>

/**
 * Build a verifier. `getKey` defaults to the team's published JWKS
 * (`<issuer>/cdn-cgi/access/certs`, cached + rotated by jose); tests inject
 * a local key instead.
 */
export function createAccessVerifier(cfg: AccessConfig, getKey?: JWTVerifyGetKey): AccessVerifier {
  const keys = getKey ?? createRemoteJWKSet(new URL(`${cfg.issuer}/cdn-cgi/access/certs`))
  return async (token, expectedEmail) => {
    if (!token) return { ok: false, reason: 'missing Access token' }
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: cfg.issuer,
        audience: cfg.aud,
        algorithms: ['RS256'],
      })
      const email = typeof payload['email'] === 'string' ? payload['email'].toLowerCase() : ''
      if (!email || email !== expectedEmail.trim().toLowerCase()) {
        return { ok: false, reason: 'Access identity does not match the admin account' }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: `invalid Access token (${(err as Error).name})` }
    }
  }
}

/** Process-wide config, read once at startup. */
export const ACCESS_CONFIG = accessConfigFromEnv()
