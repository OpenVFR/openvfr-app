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
