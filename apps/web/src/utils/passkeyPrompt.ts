/**
 * Browser-side state for the "set up a passkey" offer shown after an
 * email-code sign-in (rules: @open-vfr/shared/passkeyPrompt).
 */
import {
  afterDismissal, parsePasskeyPromptState, type PasskeyPromptState,
} from '@open-vfr/shared/passkeyPrompt'

const key = (userId: string) => `ovfr:passkeyPrompt:${userId}`

// Set when a code sign-in just succeeded; the offer consumes it, so restoring a
// session on page load never triggers it.
let otpSignInPending = false
export function markOtpSignIn(): void { otpSignInPending = true }
export function consumeOtpSignIn(): boolean {
  const v = otpSignInPending
  otpSignInPending = false
  return v
}

export function loadPromptState(userId: string): PasskeyPromptState {
  try { return parsePasskeyPromptState(localStorage.getItem(key(userId))) }
  catch { return parsePasskeyPromptState(null) }
}

export function recordDismissal(userId: string, prev: PasskeyPromptState, never = false): void {
  try { localStorage.setItem(key(userId), JSON.stringify(afterDismissal(prev, Date.now(), never))) }
  catch { /* storage blocked: the offer may repeat, Settings still has it */ }
}
