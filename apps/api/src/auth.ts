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
  user:         { modelName: 'ba_user' },
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
      // Sent via Brevo (see mailer.ts). Falls back to a console log when
      // BREVO_API_KEY / BREVO_SENDER_EMAIL are unset, e.g. in local dev.
      sendVerificationOTP: async ({ email, otp, type }) => {
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
