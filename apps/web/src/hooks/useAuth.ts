/**
 * useAuth — better-auth client hook for open-vfr.
 *
 * Provides email OTP + passkey authentication.
 * The PostgREST JWT is held in React state (never localStorage — avoids XSS).
 *
 * Usage:
 *   const { user, loading, sendOtp, signInOtp, signInPasskey, registerPasskey, signOut } = useAuth()
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { createAuthClient } from 'better-auth/client'
import { emailOTPClient }   from 'better-auth/client/plugins'
import { passkeyClient }    from '@better-auth/passkey/client'
import { API_BASE_URL } from '../utils/env'
import { flagWipeOnSignOut } from '../db/userScope'
import { flushBeforeSignOut, stopCloudSync } from '../sync/cloudSync'

// ---------------------------------------------------------------------------
// Client singleton — created once per app lifecycle.
//
// baseURL must be absolute in production if you deploy the frontend and
// API on different origins/subdomains (see docs/self-hosting.md). Falls
// back to window.location.origin in dev, where API_BASE_URL is '' and
// Vite's proxy (vite.config.ts) forwards /api/auth to the local server,
// matching same-origin production behavior exactly.
// ---------------------------------------------------------------------------
const authClient = createAuthClient({
  baseURL: `${API_BASE_URL || window.location.origin}/api/auth`,
  // credentials: 'include' is required if you deploy the frontend and API
  // on different subdomains — without it, the session cookie (set with a
  // shared parent domain) wouldn't be sent on cross-subdomain requests.
  fetchOptions: { credentials: 'include' },
  plugins: [emailOTPClient(), passkeyClient()],
})

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface AuthUser {
  id:    string
  email: string
  name:  string
}

export interface PasskeyInfo {
  id:         string
  name:       string | null
  createdAt:  Date | null
}

export interface AuthState {
  user:    AuthUser | null
  loading: boolean
  /** Step 1 — send a 6-digit OTP to the given email. */
  sendOtp:         (email: string) => Promise<void>
  /** Step 2 — verify the OTP and sign in. */
  signInOtp:       (email: string, otp: string) => Promise<void>
  /** Sign in with a stored passkey (WebAuthn) via explicit browser modal. */
  signInPasskey:   () => Promise<void>
  /** Register a new passkey for the currently signed-in user. */
  registerPasskey: (name?: string) => Promise<void>
  /** List all passkeys for the current user. */
  listPasskeys:    () => Promise<PasskeyInfo[]>
  /** Delete a passkey by ID. */
  deletePasskey:   (id: string) => Promise<void>
  /** Update the current user's profile (e.g. name on first sign-in). */
  updateUser: (data: { name: string }) => Promise<void>
  /**
   * Request permanent account deletion. Sends a one-time confirmation link
   * to the user's email (see auth.ts sendDeleteAccountVerification) —
   * the account and all associated data are only deleted once that link
   * is clicked, not immediately on this call.
   */
  requestAccountDeletion: () => Promise<void>
  signOut:    () => Promise<void>
}

// Service-worker runtime caches of API responses (vite.config.ts workbox
// runtimeCaching). The terrain cache is keyed by the coordinates of routes
// this account planned and flew, so it goes with the account's other local
// data on sign-out; weather and NOTAM caches go too, for a clean slate.
const API_RESPONSE_CACHES = ['elevation-cache', 'wx-cache', 'notam-cache']

async function clearApiResponseCaches(): Promise<void> {
  if (typeof caches === 'undefined') return
  await Promise.all(API_RESPONSE_CACHES.map((name) => caches.delete(name).catch(() => false)))
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useAuth(): AuthState {
  const [user,    setUser]    = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  // Fetch the current session. (Cloud sync fetches its own PostgREST JWT,
  // see sync/cloudSync.ts.)
  // `silent` (after an explicit sign-in) skips the loading flag: App.tsx renders
  // nothing while `loading`, which unmounted the login panel mid sign-in and
  // reset it to the email step. Returns whether a session exists.
  const refreshSession = useCallback(async (silent = false): Promise<boolean> => {
    if (!silent) setLoading(true)
    try {
      const session = await authClient.getSession()
      if (session?.data?.user) {
        const u = session.data.user
        setUser({ id: u.id, email: u.email ?? '', name: u.name ?? '' })
        return true
      }
      setUser(null)
      return false
    } catch (err) {
      console.warn('[useAuth] session refresh failed:', err)
      setUser(null)
      return false
    } finally {
      setLoading(false)
    }
  }, [])

  // Check session on mount.
  useEffect(() => { void refreshSession() }, [refreshSession])

  const sendOtp = useCallback(async (email: string) => {
    const result = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' })
    if (result.error) throw new Error(result.error.message ?? 'Failed to send OTP')
  }, [])

  const signInOtp = useCallback(async (email: string, otp: string) => {
    const result = await authClient.signIn.emailOtp({ email, otp })
    if (result.error) throw new Error(result.error.message ?? 'Invalid code')
    if (!(await refreshSession(true))) {
      throw new Error('Code accepted, but the browser did not keep the session. Check that cookies are allowed for the API host and that the app and API share a domain.')
    }
  }, [refreshSession])

  const signInPasskey = useCallback(async () => {
    let result: Awaited<ReturnType<typeof authClient.signIn.passkey>> | undefined
    try {
      result = await authClient.signIn.passkey({ autoFill: false })
    } catch (err) {
      // Browser threw NotAllowedError (no credentials / user cancelled)
      if (err instanceof Error && (err.name === 'NotAllowedError' || err.message.toLowerCase().includes('not allowed')))
        throw new Error('NO_PASSKEY')
      throw err
    }
    if (result?.error) {
      const code = (result.error as Record<string, unknown>).code
      if (code === 'AUTH_CANCELLED') throw new Error('NO_PASSKEY')
      throw new Error(result.error.message ?? 'Passkey sign-in failed')
    }
    await refreshSession(true)
  }, [refreshSession])

  const registerPasskey = useCallback(async (name?: string) => {
    const result = await authClient.passkey.addPasskey({ name: name?.trim() || 'OpenVFR passkey' })
    if (result?.error) {
      const { code, message } = result.error as { code?: string; message?: string }
      if (code === 'SESSION_NOT_FRESH' || /not fresh/i.test(message ?? '')) {
        throw new Error('For security, adding a passkey needs a recent sign-in. Sign out, sign in again with an email code, then retry.')
      }
      throw new Error(message ?? 'Passkey registration failed')
    }
  }, [])

  const updateUser = useCallback(async (data: { name: string }) => {
    const result = await authClient.updateUser(data)
    if (result?.error) throw new Error(result.error.message ?? 'Failed to update profile')
    await refreshSession(true)
  }, [refreshSession])

  const listPasskeys = useCallback(async (): Promise<PasskeyInfo[]> => {
    const result = await authClient.passkey.listUserPasskeys()
    if (result?.error) throw new Error(result.error.message ?? 'Failed to list passkeys')
    return (result.data ?? []).map((p: { id: string; name?: string | null; createdAt?: Date | string | null }) => ({
      id:        p.id,
      name:      p.name ?? null,
      createdAt: p.createdAt ? new Date(p.createdAt) : null,
    }))
  }, [])

  const deletePasskey = useCallback(async (id: string) => {
    const result = await authClient.passkey.deletePasskey({ id })
    if (result?.error) throw new Error(result.error.message ?? 'Failed to delete passkey')
  }, [])

  const requestAccountDeletion = useCallback(async () => {
    const result = await authClient.deleteUser({
      callbackURL: `${window.location.origin}/`,
    })
    if (result?.error) throw new Error(result.error.message ?? 'Failed to request account deletion')
  }, [])

  // One sign-out at a time: a repeated click while the first is still sending
  // unsynced data would run the whole sequence again in parallel.
  const signingOutRef = useRef(false)
  const signOut = useCallback(async () => {
    if (signingOutRef.current) return
    signingOutRef.current = true
    try { await signOutOnce() } finally { signingOutRef.current = false }
  }, [])
  const signOutOnce = async () => {
    // Sign-out wipes this browser's copy of the account's data: send what has
    // not reached the server yet, and ask before dropping what still can't be.
    if (!(await flushBeforeSignOut()) && !window.confirm(
      'Some routes, aircraft, waypoints, settings or flight logs in this browser have not reached the cloud yet (no connection?). Signing out deletes them from this browser. Sign out anyway?',
    )) return
    await stopCloudSync()
    // A failed request (offline, server down) must not skip the local wipe
    // below; the server session then simply expires on its own.
    try {
      const res = await authClient.signOut()
      if (res?.error) console.warn('[useAuth] server sign-out failed; signing out locally:', res.error)
    } catch (err) {
      console.warn('[useAuth] server sign-out failed; signing out locally:', err)
    }
    // The local copy of this account's data must not survive into the next
    // sign-in; useSync wipes it once cloud sync has stopped.
    flagWipeOnSignOut()
    await clearApiResponseCaches()
    setUser(null)
  }

  return { user, loading, sendOtp, signInOtp, signInPasskey, registerPasskey, listPasskeys, deletePasskey, updateUser, requestAccountDeletion, signOut }
}
