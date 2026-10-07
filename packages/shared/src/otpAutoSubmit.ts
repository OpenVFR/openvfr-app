/**
 * When to submit a sign-in code automatically, shared by web and native.
 *
 * Real email codes are exactly OTP_LENGTH digits, but the fixed app-review
 * test code (see the API's auth config) is at least 10 digits and the inputs
 * accept up to 32, so a typed code reaching OTP_LENGTH digits can't mean
 * "done". Only a single change that fills the field with exactly OTP_LENGTH
 * digits (email-code autofill or paste) submits on its own; typed digits never
 * do, and the Sign in button / Enter key work for any length.
 */
export const OTP_LENGTH = 6

export function shouldAutoSubmitOtp(prev: string, next: string): boolean {
  return next.length === OTP_LENGTH && next.length - prev.length >= 2
}
