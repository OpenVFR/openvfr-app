/**
 * better-auth client configured for React Native.
 *
 * Cookie issue & bearer workaround:
 *   React Native's fetch silently drops Set-Cookie response headers.
 *   The server's `bearer()` plugin causes better-auth to return the session
 *   token as JSON so we can store it in AsyncStorage and send it as
 *   `Authorization: Bearer <token>` on subsequent requests.
 *
 * Passkeys:
 *   Uses `react-native-passkey` which wraps the native platform authenticator
 *   APIs directly (iOS ASAuthorizationController / Android CredentialManager).
 *   This is the same underlying mechanism Capacitor uses — fully supported.
 */

import { createAuthClient }   from 'better-auth/client'
import { emailOTPClient }     from 'better-auth/client/plugins'
import { passkeyClient }      from '@better-auth/passkey/client'
import AsyncStorage           from '@react-native-async-storage/async-storage'
import { API_BASE }           from '../config'

// ---------------------------------------------------------------------------
// Async storage adapter
// ---------------------------------------------------------------------------
const asyncStorageAdapter = {
  getItem:    (key: string)              => AsyncStorage.getItem(key),
  setItem:    (key: string, val: string) => AsyncStorage.setItem(key, val),
  removeItem: (key: string)              => AsyncStorage.removeItem(key),
}

// ---------------------------------------------------------------------------
// better-auth client
// ---------------------------------------------------------------------------
export const authClient = createAuthClient({
  baseURL: API_BASE,
  fetchOptions: {
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
    // but nothing was ever capturing it and writing it into AsyncStorage under
    // the 'better-auth-token' key that authHeaders() (below) reads from —
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
      if (token) AsyncStorage.setItem('better-auth-token', token).catch(() => {})
    },
  },
  plugins: [
    emailOTPClient(),
    passkeyClient(),
  ],
  storage: asyncStorageAdapter,
})

// ---------------------------------------------------------------------------
// Helper: Authorization header for manual fetch() calls (PostgREST, etc.)
// ---------------------------------------------------------------------------
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await AsyncStorage.getItem('better-auth-token')
  if (!token) return {}
  return { Authorization: `Bearer ${token}` }
}
