/**
 * Pilot-facing text for a failed passkey request to the API (web + native).
 *
 * The server refuses to add a passkey when the sign-in is more than a day old
 * (403, code SESSION_NOT_FRESH, "Session is not fresh"), and answers 401 when
 * the stored session is no longer valid. Both are fixed the same way, by
 * signing in again with an email code, so say so instead of showing the raw
 * server text.
 */
export const PASSKEY_RECENT_SIGN_IN_MESSAGE =
  'For security, adding a passkey needs a recent sign-in. Sign out, sign in again with an email code, then try again.'

export const PASSKEY_SESSION_EXPIRED_MESSAGE =
  'Your sign-in has expired. Sign out, sign in again with an email code, then try again.'

export interface PasskeyRequestError {
  status?: number
  code?: string
  message?: string
}

export function passkeyRequestErrorMessage(e: PasskeyRequestError, fallback: string): string {
  const code = (e.code ?? '').toUpperCase()
  const text = e.message ?? ''
  if (code === 'SESSION_NOT_FRESH' || /not fresh/i.test(text)) return PASSKEY_RECENT_SIGN_IN_MESSAGE
  if (e.status === 401 || code === 'UNAUTHORIZED') return PASSKEY_SESSION_EXPIRED_MESSAGE
  return text || fallback
}
