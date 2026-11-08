/**
 * Device-side state for the "set up a passkey" offer shown after an email-code
 * sign-in (rules: @open-vfr/shared/passkeyPrompt).
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  afterDismissal, parsePasskeyPromptState, type PasskeyPromptState,
} from '@open-vfr/shared/passkeyPrompt'

const key = (userId: string) => `ovfr:passkeyPrompt:${userId}`

// Set when a code sign-in just succeeded; the offer consumes it, so restoring a
// stored session at app start never triggers it.
let otpSignInPending = false
export function markOtpSignIn(): void { otpSignInPending = true }
export function consumeOtpSignIn(): boolean {
  const v = otpSignInPending
  otpSignInPending = false
  return v
}

export async function loadPromptState(userId: string): Promise<PasskeyPromptState> {
  try { return parsePasskeyPromptState(await AsyncStorage.getItem(key(userId))) }
  catch { return parsePasskeyPromptState(null) }
}

export async function recordDismissal(userId: string, prev: PasskeyPromptState, never = false): Promise<void> {
  await AsyncStorage.setItem(key(userId), JSON.stringify(afterDismissal(prev, Date.now(), never))).catch(() => {})
}
