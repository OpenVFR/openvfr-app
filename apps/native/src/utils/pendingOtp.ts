import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * "Code sent, waiting for it" marker so the login screen can resume the code
 * step after an app restart (LoginScreen). It must be cleared by the auth
 * hook, not by the screen: the screen unmounts the moment sign-in succeeds,
 * so a screen-side cleanup never runs and the marker survived into the next
 * sign-out (which then opened on the code step instead of a clean login).
 */
export const PENDING_OTP_KEY = 'login.pendingOtp'
export const PENDING_OTP_TTL_MS = 10 * 60 * 1000

export function clearPendingOtp(): Promise<void> {
  return AsyncStorage.removeItem(PENDING_OTP_KEY).catch(() => {})
}
