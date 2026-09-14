/**
 * useAuth — better-auth client hook for open-vfr.
 *
 * Provides email OTP + passkey authentication.
 * The PostgREST JWT is held in React state (never localStorage — avoids XSS).
 *
 * Usage:
 *   const { user, jwt, loading, sendOtp, signInOtp, signInPasskey, registerPasskey, signOut } = useAuth()
 */

import { useState, useEffect, useCallback } from 'react'
import { createAuthClient } from 'better-auth/client'
import { emailOTPClient }   from 'better-auth/client/plugins'
import { passkeyClient }    from '@better-auth/passkey/client'
import { API_BASE_URL } from '../utils/env'

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
  jwt:     string | null
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

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useAuth(): AuthState {
  const [user,    setUser]    = useState<AuthUser | null>(null)
  const [jwt,     setJwt]     = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Fetch the current session and (if authed) a fresh PostgREST JWT.
  const refreshSession = useCallback(async () => {
    setLoading(true)
    try {
      const session = await authClient.getSession()
      if (session?.data?.user) {
        const u = session.data.user
        setUser({ id: u.id, email: u.email ?? '', name: u.name ?? '' })
        // Exchange session cookie for a short-lived PostgREST JWT.
        const res = await fetch(`${API_BASE_URL}/api/auth/token`, { credentials: 'include' })
        if (res.ok) {
          const { jwt: newJwt } = await res.json() as { jwt: string }
          setJwt(newJwt)
        }
      } else {
        setUser(null)
        setJwt(null)
      }
    } catch (err) {
      console.warn('[useAuth] session refresh failed:', err)
      setUser(null)
      setJwt(null)
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
    await refreshSession()
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
    await refreshSession()
  }, [refreshSession])

  const registerPasskey = useCallback(async (name?: string) => {
    const result = await authClient.passkey.addPasskey({ name: name?.trim() || 'OpenVFR passkey' })
    if (result?.error) throw new Error(result.error.message ?? 'Passkey registration failed')
  }, [])

  const updateUser = useCallback(async (data: { name: string }) => {
    const result = await authClient.updateUser(data)
    if (result?.error) throw new Error(result.error.message ?? 'Failed to update profile')
    await refreshSession()
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

  const signOut = useCallback(async () => {
    await authClient.signOut()
    setUser(null)
    setJwt(null)
  }, [])

  return { user, jwt, loading, sendOtp, signInOtp, signInPasskey, registerPasskey, listPasskeys, deletePasskey, updateUser, requestAccountDeletion, signOut }
}
