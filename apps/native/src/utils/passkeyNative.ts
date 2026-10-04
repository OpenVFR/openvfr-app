/**
 * Native passkey (WebAuthn) ceremonies for React Native.
 *
 * `@better-auth/passkey/client` drives the *browser* WebAuthn API
 * (`navigator.credentials` via @simplewebauthn/browser), which does not exist
 * in React Native. This module performs the same two-step ceremonies against
 * the same better-auth server endpoints, but hands the platform step to
 * `react-native-passkey` (iOS ASAuthorizationController / Android
 * CredentialManager).
 *
 *   sign in:   GET  /passkey/generate-authenticate-options
 *              → Passkey.get(options)
 *              → POST /passkey/verify-authentication   { response }
 *
 *   register:  GET  /passkey/generate-register-options
 *              → Passkey.create(options)
 *              → POST /passkey/verify-registration      { response, name }
 *
 * Challenge cookie:
 *   The server binds the pending challenge to a short-lived signed cookie set
 *   on the generate-options response and read back on verify. React Native's
 *   fetch does not expose Set-Cookie to JS reliably across platforms and does
 *   not guarantee the native cookie jar re-sends it, so we capture the header
 *   when available and forward it explicitly as `Cookie` on the verify call.
 *   If the native jar already sends it, the duplicate is harmless.
 *
 * Server prerequisites (see docs/self-hosting.md): RP ID = registrable apex,
 * `apple-app-site-association` (iOS) and `assetlinks.json` (Android) served
 * from https://<rpID>/.well-known/, and the Android apk-key-hash origin(s)
 * listed in the server's allowed WebAuthn origins.
 */

import { Platform } from 'react-native'
import { Passkey } from 'react-native-passkey'
import type {
  PasskeyCreateRequest, PasskeyCreateResult, PasskeyGetRequest, PasskeyGetResult,
} from 'react-native-passkey'
import { authClient, authHeaders } from './authClient'

export type PasskeyUser = { id: string; email: string; name: string | null }

export type PasskeyOutcome =
  | { ok: true;  user: PasskeyUser | null }
  | { ok: false; cancelled: boolean; message: string }

/** True when the OS can offer passkeys at all (iOS 15+/Android 9+ with a provider). */
export function isPasskeySupported(): boolean {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false
  try { return Passkey.isSupported() } catch { return false }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collapse a Set-Cookie header (possibly several, comma-joined) into a Cookie header value. */
function toCookieHeader(setCookie: string | null): string | undefined {
  if (!setCookie) return undefined
  // Split only on commas that start a new `name=value` pair (Expires dates also contain commas).
  const pairs = setCookie
    .split(/,(?=\s*[^;,=\s]+=)/)
    .map(c => c.split(';')[0]?.trim())
    .filter((c): c is string => !!c && c.includes('='))
  return pairs.length ? pairs.join('; ') : undefined
}

type Fetched<T> = { data: T; cookie?: string } | { error: string }

async function getOptions<T>(path: string, auth: boolean): Promise<Fetched<T>> {
  let cookie: string | undefined
  const headers: Record<string, string> = auth ? await authHeaders() : {}
  const { data, error } = await authClient.$fetch<T>(path, {
    method: 'GET',
    headers,
    throw: false,
    onResponse: (ctx) => { cookie = toCookieHeader(ctx.response.headers.get('set-cookie')) },
  })
  if (error || !data) return { error: error?.message ?? 'Could not reach the server' }
  return { data, cookie }
}

async function verify<T>(
  path: string, body: unknown, cookie: string | undefined, auth: boolean,
): Promise<{ data: T } | { error: string }> {
  const headers: Record<string, string> = auth ? await authHeaders() : {}
  if (cookie) headers['Cookie'] = cookie
  const { data, error } = await authClient.$fetch<T>(path, {
    method: 'POST',
    body,
    headers,
    throw: false,
  })
  if (error || !data) return { error: error?.message ?? 'Verification failed' }
  return { data }
}

/** Translate react-native-passkey errors; `cancelled` means "user backed out — stay silent". */
function fromPlatformError(e: unknown): { cancelled: boolean; message: string } {
  const code = (e as { error?: string })?.error ?? ''
  const msg  = (e as { message?: string })?.message ?? String(e)
  switch (code) {
    case 'UserCancelled':
    case 'Interrupted':
      return { cancelled: true, message: 'Passkey prompt cancelled' }
    case 'NoCredentials':
      return { cancelled: false, message: 'No passkey found on this device. Sign in with an email code, then register one in Settings.' }
    case 'NotSupported':
      return { cancelled: false, message: 'Passkeys are not supported on this device.' }
    case 'NoCreateOption':
      return { cancelled: false, message: 'No credential provider available. Sign in to a Google account or set a screen lock first.' }
    case 'CredentialAlreadyExists':
      return { cancelled: false, message: 'A passkey for this account already exists on this device.' }
    case 'Timeout':
      return { cancelled: false, message: 'Passkey prompt timed out.' }
    default:
      return { cancelled: false, message: msg || 'Passkey failed' }
  }
}

type SessionResponse = { user?: { id: string; email: string; name?: string | null } }

function toUser(r: SessionResponse | null | undefined): PasskeyUser | null {
  return r?.user ? { id: r.user.id, email: r.user.email, name: r.user.name ?? null } : null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Sign in with an existing passkey. Resolves with the signed-in user on success. */
export async function passkeySignIn(): Promise<PasskeyOutcome> {
  const opts = await getOptions<PasskeyGetRequest>('/passkey/generate-authenticate-options', false)
  if ('error' in opts) return { ok: false, cancelled: false, message: opts.error }

  let assertion: PasskeyGetResult
  try {
    assertion = await Passkey.get(opts.data)
  } catch (e) {
    return { ok: false, ...fromPlatformError(e) }
  }

  // Strip clientExtensionResults like the web client does; the server only reads the core fields.
  const { clientExtensionResults: _ext, ...response } = assertion as PasskeyGetResult & { clientExtensionResults?: unknown }
  const res = await verify<SessionResponse>('/passkey/verify-authentication', { response }, opts.cookie, false)
  if ('error' in res) return { ok: false, cancelled: false, message: res.error }
  return { ok: true, user: toUser(res.data) }
}

/** Register a new passkey for the currently signed-in user. */
export async function passkeyRegister(name?: string): Promise<PasskeyOutcome> {
  const opts = await getOptions<PasskeyCreateRequest>('/passkey/generate-register-options', true)
  if ('error' in opts) return { ok: false, cancelled: false, message: opts.error }

  let attestation: PasskeyCreateResult
  try {
    attestation = await Passkey.create(opts.data)
  } catch (e) {
    return { ok: false, ...fromPlatformError(e) }
  }

  const { clientExtensionResults: _ext, ...response } = attestation as PasskeyCreateResult & { clientExtensionResults?: unknown }
  const body = name ? { response, name } : { response }
  const res = await verify<SessionResponse>('/passkey/verify-registration', body, opts.cookie, true)
  if ('error' in res) return { ok: false, cancelled: false, message: res.error }
  return { ok: true, user: toUser(res.data) }
}
