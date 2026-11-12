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

/**
 * A passkey prompt that failed in the browser (not a server answer). The
 * passkey client (better-auth, over @simplewebauthn) always words these
 * "Auth cancelled" whatever went wrong and puts the real reason in the code,
 * so the code decides:
 *  - cancelled: the pilot dismissed the prompt, or there is no passkey for
 *    this site on this device (browsers report both as "not allowed", by
 *    design: the app cannot tell them apart);
 *  - message: something specific the pilot can act on.
 */
export type PasskeyCeremonyOutcome = { kind: 'cancelled' } | { kind: 'message'; message: string }

export const PASSKEY_WRONG_SITE_MESSAGE =
  'Passkeys only work on the site they were made for, and this address is not that site (for example a test or preview address). Sign in with an email code instead.'

export function passkeyCeremonyOutcome(e: { code?: string }): PasskeyCeremonyOutcome {
  const code = (e.code ?? '').toUpperCase()
  switch (code) {
    case '':
    case 'AUTH_CANCELLED':
    case 'ERROR_CEREMONY_ABORTED':
    // "Not allowed": cancelled, timed out, or no credential for this site.
    case 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY':
      return { kind: 'cancelled' }
    case 'ERROR_INVALID_RP_ID':
    case 'ERROR_INVALID_DOMAIN':
      return { kind: 'message', message: PASSKEY_WRONG_SITE_MESSAGE }
    case 'ERROR_AUTHENTICATOR_GENERAL_ERROR':
      return { kind: 'message', message: 'The device could not use the passkey. Try again, or sign in with an email code.' }
    default:
      return { kind: 'message', message: `Passkey sign-in failed (${code}). Sign in with an email code instead.` }
  }
}
