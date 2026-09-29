/**
 * useAuth — auth state + email OTP sign-in / sign-out for React Native.
 *
 * Flow:
 *   1. sendOtp(email)           → server sends a 6-digit code to the inbox
 *   2. verifyOtp(email, code)   → server verifies, returns bearer token
 *                                  stored by better-auth client in AsyncStorage
 *   3. signOut()                → clears server session + local token
 *
 * Passkeys are intentionally not supported on native (WebAuthn is browser-only).
 */

import { useEffect, useState, useCallback } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { authClient } from '../utils/authClient'

export type AuthUser = {
  id:    string
  email: string
  name:  string | null
}

export type AuthState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; user: AuthUser }

const CACHED_USER_KEY = 'openvfr-cached-user'

async function readCachedUser(): Promise<AuthUser | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHED_USER_KEY)
    // A cached user is only useful together with the bearer token that
    // authHeaders() sends once back online; without one it's stale.
    if (!raw || !(await AsyncStorage.getItem('better-auth-token'))) return null
    const u = JSON.parse(raw) as AuthUser
    return u?.id && u?.email ? u : null
  } catch {
    return null
  }
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({ status: 'loading' })
  const [error, setError] = useState<string | null>(null)

  // Restore session on mount
  useEffect(() => {
    // Offline start (no signal in flight) must still open the app: when the
    // session check fails for a *network* reason (thrown, or no HTTP status /
    // 5xx), fall back to the last signed-in user. An explicit "no session"
    // or 4xx answer from the server still signs the user out.
    const fallbackOffline = async () => {
      const cached = await readCachedUser()
      if (cached) {
        console.log('[auth] offline, using cached user', cached.email)
        setState({ status: 'authenticated', user: cached })
      } else {
        setState({ status: 'unauthenticated' })
      }
    }
    authClient.getSession()
      .then(async ({ data, error: err }) => {
        if (data?.user) {
          console.log('[auth] restored session for', data.user.email)
          const user = { id: data.user.id, email: data.user.email, name: data.user.name ?? null }
          AsyncStorage.setItem(CACHED_USER_KEY, JSON.stringify(user)).catch(() => {})
          setState({ status: 'authenticated', user })
        } else if (err && (!err.status || err.status >= 500)) {
          await fallbackOffline()
        } else {
          console.log('[auth] no session')
          AsyncStorage.removeItem(CACHED_USER_KEY).catch(() => {})
          setState({ status: 'unauthenticated' })
        }
      })
      .catch(async (e) => {
        console.warn('[auth] getSession failed', e)
        await fallbackOffline()
      })
  }, [])

  const sendOtp = useCallback(async (email: string): Promise<boolean> => {
    setError(null)
    console.log('[auth] sendOtp →', email)
    const { error: err } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: 'sign-in',
    })
    if (err) {
      console.warn('[auth] sendOtp error', err)
      setError(err.message ?? 'Failed to send code')
      return false
    }
    console.log('[auth] sendOtp ok')
    return true
  }, [])

  const verifyOtp = useCallback(async (email: string, otp: string): Promise<boolean> => {
    setError(null)
    console.log('[auth] verifyOtp →', email)
    // signIn.emailOtp is the correct endpoint for OTP sign-in (not emailOtp.verifyEmail
    // which is for email-verification flows, not sign-in).
    const { data, error: err } = await authClient.signIn.emailOtp({ email, otp })
    if (err) {
      console.warn('[auth] verifyOtp error', err)
      setError(err.message ?? 'Invalid code')
      return false
    }
    if (data?.user) {
      console.log('[auth] signed in as', data.user.email)
      setState({
        status: 'authenticated',
        user: { id: data.user.id, email: data.user.email, name: data.user.name ?? null },
      })
    }
    return true
  }, [])

  const signInWithPasskey = useCallback(async (): Promise<boolean> => {
    setError(null)
    console.log('[auth] signInWithPasskey')
    const { data, error: err } = await authClient.signIn.passkey()
    if (err) {
      console.warn('[auth] passkey error', err)
      setError(err.message ?? 'Passkey sign-in failed')
      return false
    }
    if (data?.user) {
      console.log('[auth] signed in via passkey as', data.user.email)
      setState({
        status: 'authenticated',
        user: { id: data.user.id, email: data.user.email, name: data.user.name ?? null },
      })
    }
    return true
  }, [])

  const signOut = useCallback(async () => {
    console.log('[auth] signOut')
    await authClient.signOut()
    // Clear the manually-captured bearer token too (see authClient.ts's
    // onSuccess hook) -- otherwise a stale token from the just-ended session
    // would keep being sent by authHeaders()-based fetches (traffic, regional
    // NOTAMs, weather-along-route) until overwritten by a future sign-in.
    await AsyncStorage.removeItem('better-auth-token').catch(() => {})
    await AsyncStorage.removeItem(CACHED_USER_KEY).catch(() => {})
    setState({ status: 'unauthenticated' })
  }, [])

  // Request permanent account deletion, required by Apple App Review Guideline
  // 5.1.1(v) and Google Play's account-deletion requirement (see apps/api/src
  // /auth.ts deleteUser config). Sends a one-time confirmation link to the
  // user's email -- nothing is deleted until that link is clicked, so this
  // resolves without a passkey/re-auth step even though native has no
  // passkey sign-in of its own.
  const requestAccountDeletion = useCallback(async (): Promise<boolean> => {
    setError(null)
    console.log('[auth] requestAccountDeletion')
    const { error: err } = await authClient.deleteUser()
    if (err) {
      console.warn('[auth] requestAccountDeletion error', err)
      setError(err.message ?? 'Failed to request account deletion')
      return false
    }
    console.log('[auth] account deletion email sent')
    return true
  }, [])

  const registerPasskey = useCallback(async (): Promise<boolean> => {
    setError(null)
    console.log('[auth] registerPasskey')
    const { error: err } = await authClient.passkey.addPasskey()
    if (err) {
      console.warn('[auth] registerPasskey error', err)
      setError(err.message ?? 'Failed to register passkey')
      return false
    }
    console.log('[auth] passkey registered')
    return true
  }, [])

  return { state, error, sendOtp, verifyOtp, signInWithPasskey, registerPasskey, requestAccountDeletion, signOut }
}
