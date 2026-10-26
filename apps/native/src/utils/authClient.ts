/**
 * better-auth client configured for React Native.
 *
 * Cookie issue & bearer workaround:
 *   React Native's fetch silently drops Set-Cookie response headers.
 *   The server's `bearer()` plugin causes better-auth to return the session
 *   token in a `set-auth-token` header so we can keep it in secure storage
 *   (utils/sessionToken.ts) and send it as `Authorization: Bearer <token>`
 *   on subsequent requests.
 *
 * Passkeys:
 *   `passkeyClient()` is kept only for its typed `listUserPasskeys` /
 *   `deletePasskey` helpers. Its `signIn.passkey()` / `addPasskey()` call the
 *   browser WebAuthn API and will NOT work in React Native — use
 *   utils/passkeyNative.ts, which drives `react-native-passkey` against the
 *   same server endpoints.
 */

import { createAuthClient }   from 'better-auth/client'
import { emailOTPClient }     from 'better-auth/client/plugins'
import { passkeyClient }      from '@better-auth/passkey/client'
import { API_BASE }           from '../config'
import { getSessionToken, setSessionToken } from './sessionToken'

// ---------------------------------------------------------------------------
// better-auth client
// ---------------------------------------------------------------------------
export const authClient = createAuthClient({
  baseURL: API_BASE,
  fetchOptions: {
    // A request that never completes (seen on the iOS simulator: the OTP send
    // left the login screen on its spinner for minutes with no response)
    // would otherwise hang the sign-in UI forever: better-fetch has no default
    // timeout. Turn it into an error the screen can show and the user can
    // retry. Generous, since passkey and session calls share this client.
    timeout: 30_000,
    headers: {
      // React Native fetch omits Origin (browser-only concept). better-auth
      // requires it for CSRF protection — send the API base as the origin so
      // it matches the server's trustedOrigins list.
      Origin: API_BASE,
    },
    // BUG FIX (found live: /api/traffic/latest silently returning nothing on
    // device — Air Traffic toggle showed zero aircraft with no error). The
    // server's bearer() plugin returns the session token in a 'set-auth-token'
    // response header on every request (per better-auth's own bearer docs),
    // but nothing was ever capturing it and storing it where authHeaders()
    // (below) reads it from (now secure storage, utils/sessionToken.ts) —
    // that function has always returned {} in practice, silently downgrading
    // every authHeaders()-based fetch (traffic, regional NOTAMs, weather-
    // along-route) to an unauthenticated request. Some of those happened to
    // still work because getSession()'s own internal $fetch calls run through
    // this same onSuccess hook and DO refresh the token on session-restore/
    // sign-in calls specifically -- but authHeaders() itself had no source of
    // truth to read from until this global hook exists. Global onSuccess is
    // the officially documented pattern (better-auth.com/docs/plugins/bearer)
    // for exactly this: capture + persist on every response, not just sign-in.
    onSuccess: (ctx) => {
      const token = ctx.response.headers.get('set-auth-token')
      if (token) void setSessionToken(token)
    },
  },
  plugins: [
    emailOTPClient(),
    passkeyClient(),
  ],
})

// ---------------------------------------------------------------------------
// Helper: Authorization header for manual fetch() calls (PostgREST, etc.)
// ---------------------------------------------------------------------------
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getSessionToken()
  if (!token) return {}
  return { Authorization: `Bearer ${token}` }
}
