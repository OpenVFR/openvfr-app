/**
 * getSyncJwt — shared PostgREST JWT fetcher for native's sync hooks
 * (useRouteSync, useAircraftSync, useUserWaypointSync, useFlightLogSync).
 *
 * Extracted from 4 near-identical copies of the same getJwt() -- each hook
 * had its own module-level _jwt/_jwtExpiry cache and its own copy of this
 * exact fetch. Centralizing means all four now share one cache (a JWT
 * fetched by one hook is immediately usable by the others, not re-fetched
 * per hook) and the bug fix below only needs to exist in one place.
 *
 * Bug fixed here (found live 2026-09-20): authHeaders() reads the
 * 'better-auth-token' AsyncStorage key, which is only refreshed by
 * authClient's own onSuccess hook (fires on sign-in / getSession() / any
 * request routed through the authClient fetch wrapper) -- NOT by this bare
 * fetch() to /api/auth/token. If enough time passes after sign-in with no
 * other authClient-routed call in between, the stored token goes stale,
 * this request 401s, and the old per-hook getJwt() returned null completely
 * silently (no console output at all) -- every caller (pushRoute/
 * pushAircraft/etc.) then just silently no-oped, so a route/profile/
 * waypoint saved locally never reached the server, with zero trace anywhere
 * (confirmed live: RouteLibrarySheet's "Synced" cloud icon kept showing
 * green throughout, since that indicator only reflects the periodic PULL,
 * never push success/failure). Exactly the same failure class already
 * documented once before in authClient.ts for /api/traffic/latest.
 *
 * Fix: on a non-ok response, log the real status/body (matching
 * restUpsert's existing error-visibility pattern in each sync hook), then
 * force one authClient.getSession() round-trip -- which routes through the
 * onSuccess hook and refreshes 'better-auth-token' -- and retry the token
 * fetch exactly once before giving up. A second failure is treated as a
 * real connectivity/auth issue and logged, not swallowed.
 */

import { API_BASE } from '../config'
import { authHeaders, authClient } from './authClient'

let _jwt:       string | null = null
let _jwtExpiry: number        = 0

async function fetchToken(): Promise<Response> {
  return fetch(`${API_BASE}/api/auth/token`, {
    headers: { Origin: API_BASE, ...(await authHeaders()) },
  })
}

export async function getSyncJwt(): Promise<string | null> {
  if (_jwt && Date.now() < _jwtExpiry) return _jwt

  try {
    let res = await fetchToken()

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn('[syncJwt] /api/auth/token failed, retrying after session refresh', res.status, body)
      // Force authClient's own fetch wrapper to run once -- its onSuccess
      // hook is the only thing that refreshes the stored bearer token (see
      // module doc comment above). If the session itself is gone (fully
      // signed out / expired), this also fails and we give up below.
      await authClient.getSession().catch(() => {})
      res = await fetchToken()
      if (!res.ok) {
        const retryBody = await res.text().catch(() => '')
        console.error('[syncJwt] /api/auth/token failed after session refresh retry', res.status, retryBody)
        return null
      }
    }

    const body = await res.json() as { jwt: string; expiresAt: number }
    _jwt       = body.jwt
    _jwtExpiry = (body.expiresAt - 60) * 1000  // expire 60 s before actual expiry
    return _jwt
  } catch (err) {
    console.error('[syncJwt] /api/auth/token request threw', err instanceof Error ? err.message : String(err))
    return null
  }
}
