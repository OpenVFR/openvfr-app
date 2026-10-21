/**
 * Accounts that sign in with a fixed, never-expiring email OTP instead of a random one:
 *   - the app-store / Play-store review account (APP_REVIEW_TEST_EMAIL + APP_REVIEW_TEST_OTP), and
 *   - automated-test accounts (APP_TEST_ACCOUNTS="email:code,email:code"), kept separate from
 *     the review account so a test run cannot change what a reviewer sees.
 *
 * Parsing and validation live here (pure, no auth/DB imports) so they can be unit tested.
 * A code never rotates, so it needs far more entropy than a 10-minute 6-digit code: at least
 * MIN_OTP_LENGTH characters for the review account (kept at 10 so existing store submissions
 * stay valid) and MIN_TEST_OTP_LENGTH for test accounts. The login screens accept at most
 * MAX_OTP_LENGTH digits, so a test code is exactly 32 digits. Codes must differ between
 * accounts, otherwise one leaked code would open both. Throws on a misconfiguration (the API
 * refuses to start).
 */
export const MIN_OTP_LENGTH = 10
export const MIN_TEST_OTP_LENGTH = 32
export const MAX_OTP_LENGTH = 32

export interface FixedOtpEnv {
  reviewEmail?: string
  reviewOtp?: string
  testAccounts?: string
}

export interface FixedOtpAccounts {
  /** lower-cased email -> fixed code */
  byEmail: ReadonlyMap<string, string>
  warnings: string[]
}

export function parseFixedOtpAccounts(env: FixedOtpEnv): FixedOtpAccounts {
  const byEmail = new Map<string, string>()
  const warnings: string[] = []

  const add = (label: string, rawEmail: string, otp: string, minLength: number) => {
    const email = rawEmail.trim().toLowerCase()
    if (!email.includes('@')) throw new Error(`${label}: "${rawEmail}" is not an email address`)
    if (otp.length < minLength) {
      throw new Error(`${label}: the code for ${email} must be at least ${minLength} characters, it never expires/rotates unlike normal OTPs`)
    }
    if (byEmail.has(email)) throw new Error(`${label}: ${email} is configured twice`)
    for (const [other, code] of byEmail) {
      if (code === otp) throw new Error(`${label}: ${email} uses the same code as ${other}; every fixed-code account needs its own`)
    }
    // Warn, don't throw: both login UIs only accept digits (numeric keypad on native, non-digits
    // stripped on web) and cap input at 32, so such a code boots fine but cannot be typed.
    if (!/^\d+$/.test(otp)) warnings.push(`${label}: the code for ${email} contains non-digits, the login UIs only accept digits`)
    if (otp.length > MAX_OTP_LENGTH) warnings.push(`${label}: the code for ${email} is longer than ${MAX_OTP_LENGTH} digits, the login UIs cap input at ${MAX_OTP_LENGTH}`)
    byEmail.set(email, otp)
  }

  const reviewEmail = env.reviewEmail?.trim() || ''
  const reviewOtp = env.reviewOtp || ''
  if (!!reviewEmail !== !!reviewOtp) {
    throw new Error('APP_REVIEW_TEST_EMAIL and APP_REVIEW_TEST_OTP must both be set, or both left unset')
  }
  if (reviewEmail) add('APP_REVIEW_TEST_*', reviewEmail, reviewOtp, MIN_OTP_LENGTH)

  const list = env.testAccounts?.trim()
  if (list) {
    for (const entry of list.split(',').map((e) => e.trim()).filter(Boolean)) {
      const i = entry.indexOf(':')
      if (i <= 0 || i === entry.length - 1) throw new Error(`APP_TEST_ACCOUNTS: "${entry.replace(/:.*/, ':***')}" must look like email:code`)
      add('APP_TEST_ACCOUNTS', entry.slice(0, i), entry.slice(i + 1), MIN_TEST_OTP_LENGTH)
    }
  }
  return { byEmail, warnings }
}
