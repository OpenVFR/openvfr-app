/**
 * better-auth configuration for open-vfr.
 *
 * Auth strategy:
 *   - Passkeys (WebAuthn) — primary, passwordless
 *   - Magic link via email — recovery / fallback
 *
 * Session tokens are stored in PostgreSQL (same `db` service as aviation data).
 * The `BETTER_AUTH_SECRET` is shared with PostgREST as `PGRST_JWT_SECRET` so
 * PostgREST can verify JWTs issued by `GET /api/auth/token`.
 */

import { betterAuth } from 'better-auth'
import { emailOTP }   from 'better-auth/plugins'
import { passkey }    from '@better-auth/passkey'
import { bearer }     from 'better-auth/plugins'
import pg             from 'pg'
import { sendEmail }  from './mailer.js'

const { Pool } = pg

// ---------------------------------------------------------------------------
// Validate required env vars at startup (fail fast, not on first request).
// ---------------------------------------------------------------------------
const SECRET   = process.env['BETTER_AUTH_SECRET']
const BASE_URL = process.env['BETTER_AUTH_URL']
const DB_URL   = process.env['DATABASE_URL']
// Origin seen by the browser — for passkey RP validation.
// In dev this is the Vite dev server; in prod it's the app domain.
// Compose passes unset optional vars through as an empty string (e.g.
// `BETTER_AUTH_APP_ORIGIN=${BETTER_AUTH_APP_ORIGIN:-}`), not `undefined` --
// use `||` (falls through on '' too), not `??` (only falls through on
// null/undefined), or `new URL('')` throws ERR_INVALID_URL below.
const APP_ORIGIN = process.env['BETTER_AUTH_APP_ORIGIN'] || BASE_URL || 'http://localhost:5173'

// ---------------------------------------------------------------------------
// App-store / Play-store review test account.
//
// Reviewers can't receive live OTP emails, so a single allowlisted address
// gets a fixed, long OTP instead of the normal random 6-digit code. Both
// vars must be set explicitly per-deployment (never committed, unset by
// default in docker/env.prod.example) — leaving either unset disables this
// path entirely and every account uses the normal random OTP.
//
// Deliberately longer than the default otpLength: this code has no
// expiresIn rotation (it's the same value for the whole review cycle), so
// it needs more entropy than a normal 10-minute-lived 6-digit code to stay
// safe against brute force. Compared with constant-time equality by
// better-auth's own verifyStoredOTP regardless of otp length/charset.
const APP_REVIEW_TEST_EMAIL = process.env['APP_REVIEW_TEST_EMAIL']?.toLowerCase() || null
const APP_REVIEW_TEST_OTP   = process.env['APP_REVIEW_TEST_OTP'] || null
if ((APP_REVIEW_TEST_EMAIL && !APP_REVIEW_TEST_OTP) || (!APP_REVIEW_TEST_EMAIL && APP_REVIEW_TEST_OTP)) {
  throw new Error('APP_REVIEW_TEST_EMAIL and APP_REVIEW_TEST_OTP must both be set, or both left unset')
}
if (APP_REVIEW_TEST_OTP && APP_REVIEW_TEST_OTP.length < 10) {
  throw new Error('APP_REVIEW_TEST_OTP must be at least 10 characters — it never expires/rotates, unlike normal OTPs')
}

if (!SECRET || SECRET.length < 32) {
  throw new Error('BETTER_AUTH_SECRET must be set and at least 32 characters long')
}
if (!BASE_URL) {
  throw new Error('BETTER_AUTH_URL must be set (e.g. https://api.your-domain.example)')
}
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for better-auth PostgreSQL adapter')
}

// ---------------------------------------------------------------------------
// PostgreSQL pool — reused by the auth adapter.
// ---------------------------------------------------------------------------
const pool = new Pool({ connectionString: DB_URL })

// ---------------------------------------------------------------------------
// better-auth instance
// ---------------------------------------------------------------------------
export const auth = betterAuth({
  secret:  SECRET,
  baseURL: BASE_URL,

  // Allow requests from the Vite dev server (port 5173) in addition to the
  // API origin. BETTER_AUTH_TRUSTED_ORIGINS can add more origins in production.
  trustedOrigins: [
    BASE_URL,
    'http://localhost:5200',
    'http://localhost:5174',
    'http://localhost:5173',
    'http://10.0.2.2:5200',
    'http://10.0.2.2:5173',
    'http://192.168.1.243:5200',
    'http://192.168.1.243:5173',
    ...(process.env['BETTER_AUTH_TRUSTED_ORIGINS']?.split(',').map(o => o.trim()).filter(Boolean) ?? []),
  ],

  // Pass the pg Pool directly — the Kysely adapter detects it via Pool.connect.
  // init.sql pre-creates all ba_-prefixed tables; model names below map to them.
  database: pool,

  // Map better-auth model names → our ba_-prefixed table names from init.sql.
  user: {
    modelName: 'ba_user',
    // Self-service account deletion, required by Apple App Review Guideline
    // 5.1.1(v) and Google Play's Data Safety "account deletion" requirement:
    // an app that lets users create an account must let them request
    // deletion of the account and its data. Flow:
    //   1. Signed-in user clicks "Delete account" in the app (ProfilePanel).
    //   2. authClient.deleteUser() hits POST /delete-user below, which
    //      emails a one-time confirmation link (sendDeleteAccountVerification)
    //      instead of deleting immediately — prevents a stolen/left-open
    //      session from nuking the account with one misclick.
    //   3. Clicking the emailed link hits GET /delete-user/callback, which
    //      deletes the ba_user row. Every owned table (sessions, accounts,
    //      passkeys, routes, aircraft profiles, waypoints, settings, flight
    //      logs — see db/migrations) has `ON DELETE CASCADE` on its
    //      `user_id`/`userId` FK, so this one delete removes all associated
    //      data in the same transaction. No app-level cascade code needed.
    deleteUser: {
      enabled: true,
      sendDeleteAccountVerification: async ({ user, url }) => {
        await sendEmail({
          to: user.email,
          subject: 'Confirm OpenVFR account deletion',
          text: `We received a request to permanently delete your OpenVFR account (${user.email}) and all associated data (routes, aircraft profiles, waypoints, settings, flight logs).\n\nTo confirm, open this link within 24 hours:\n${url}\n\nIf you didn't request this, ignore this email — your account will not be affected.`,
        })
      },
    },
  },
  session:      { modelName: 'ba_session' },
  account:      { modelName: 'ba_account' },
  verification: { modelName: 'ba_verification' },

  plugins: [
    bearer(),   // enables Authorization: Bearer <token> for native/API clients
    passkey({
      rpID:   new URL(APP_ORIGIN).hostname,
      rpName: 'OpenVFR',
      // Accept both the web origin (e.g. https://app.your-domain.example) and the Android
      // APK key hash origin. iOS uses the same origin as the web app via
      // Associated Domains, so no separate entry is needed for it.
      // Set ANDROID_PASSKEY_ORIGIN in .env.prod once you have the SHA-256
      // fingerprint of your signing certificate (see docker/env.prod.example).
      origin: [
        APP_ORIGIN,
        ...(process.env['ANDROID_PASSKEY_ORIGIN']
          ? [process.env['ANDROID_PASSKEY_ORIGIN']]
          : []),
      ],
      schema: { passkey: { modelName: 'ba_passkey' } },
    }),
    emailOTP({
      // Fixed code for the allowlisted review account — never sent by email,
      // since reviewers can't check a live inbox. Reviewer already knows the
      // value from App Store Connect / Play Console review notes. Falling
      // through to `undefined` here makes better-auth use its own
      // defaultOTPGenerator(opts) (random, otpLength below) for every other
      // email, so this only ever affects the one allowlisted address.
      generateOTP: ({ email }) => {
        if (APP_REVIEW_TEST_EMAIL && APP_REVIEW_TEST_OTP && email.toLowerCase() === APP_REVIEW_TEST_EMAIL) {
          return APP_REVIEW_TEST_OTP
        }
        return undefined
      },
      // Sent via Brevo (see mailer.ts). Falls back to a console log when
      // BREVO_API_KEY / BREVO_SENDER_EMAIL are unset, e.g. in local dev.
      sendVerificationOTP: async ({ email, otp, type }) => {
        // Skip sending for the review account — reviewer never sees this
        // email, they type the fixed code straight from review notes.
        if (APP_REVIEW_TEST_EMAIL && email.toLowerCase() === APP_REVIEW_TEST_EMAIL) {
          return
        }
        await sendEmail({
          to: email,
          subject: 'Your OpenVFR sign-in code',
          text: `Your verification code is: ${otp}\n\nThis code expires in 10 minutes. If you didn't request this (${type}), you can ignore this email.`,
        })
      },
      otpLength:  6,
      expiresIn:  600,  // 10 minutes
    }),
  ],
})

export type Auth = typeof auth
