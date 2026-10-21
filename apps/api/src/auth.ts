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
import { emailOTP, admin } from 'better-auth/plugins'
import { passkey }    from '@better-auth/passkey'
import { parseFixedOtpAccounts } from './fixedOtpAccounts.js'
import { bearer }     from 'better-auth/plugins'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { sendEmail }  from './mailer.js'
import { pool }        from './db.js'
import { ACCESS_CONFIG } from './accessJwt.js'

// ---------------------------------------------------------------------------
// Validate required env vars at startup (fail fast, not on first request).
// ---------------------------------------------------------------------------
const SECRET   = process.env['BETTER_AUTH_SECRET']
const BASE_URL = process.env['BETTER_AUTH_URL']
// Origin seen by the browser — for passkey RP validation.
// In dev this is the Vite dev server; in prod it's the app domain.
// Compose passes unset optional vars through as an empty string (e.g.
// `BETTER_AUTH_APP_ORIGIN=${BETTER_AUTH_APP_ORIGIN:-}`), not `undefined` --
// use `||` (falls through on '' too), not `??` (only falls through on
// null/undefined), or `new URL('')` throws ERR_INVALID_URL below.
const APP_ORIGIN = process.env['BETTER_AUTH_APP_ORIGIN'] || BASE_URL || 'http://localhost:5173'
const IS_PROD = process.env['NODE_ENV'] === 'production'

// Origin of the separately deployed admin UI (e.g. https://admin.<domain>).
// Optional. When set it is trusted for sign-in (incl. passkeys) and is the
// ONLY origin the /api/admin router accepts (see admin.ts).
export const ADMIN_APP_ORIGIN = process.env['ADMIN_APP_ORIGIN']?.trim().replace(/\/+$/, '') || ''

// WebAuthn Relying Party ID. Must be the registrable apex (e.g. openvfr.org)
// when the API and app live on different subdomains, so a passkey registered
// while talking to api.<domain> is valid when asserted from app.<domain>.
// Falls back to the app origin's hostname (correct for single-origin/dev).
const RP_ID = process.env['BETTER_AUTH_RP_ID'] || new URL(APP_ORIGIN).hostname

// Shared parent domain for the session cookie (".openvfr.org") so the cookie
// set by api.<domain> is also sent to app.<domain>. Unset = same-origin only.
const COOKIE_DOMAIN = process.env['BETTER_AUTH_COOKIE_DOMAIN'] || ''

// Local-dev origins (Vite dev server, Android emulator loopback, LAN device
// testing). NEVER trusted in production -- an attacker page on any of these
// literal origins is unlikely, but there's no reason to widen the CSRF/origin
// allowlist beyond what prod actually serves.
const DEV_TRUSTED_ORIGINS = IS_PROD ? [] : [
  'http://localhost:5200',
  'http://localhost:5174',
  'http://localhost:5173',
  'http://10.0.2.2:5200',
  'http://10.0.2.2:5173',
  ...(process.env['BETTER_AUTH_DEV_LAN_ORIGINS']?.split(',').map(o => o.trim()).filter(Boolean) ?? []),
]

// ---------------------------------------------------------------------------
// Fixed-code accounts: the app-store / Play-store review account and automated-test
// accounts.
//
// Reviewers can't receive live OTP emails, and automated tests can't read an inbox, so these
// allowlisted addresses get a fixed, long OTP instead of the normal random 6-digit code.
//   APP_REVIEW_TEST_EMAIL + APP_REVIEW_TEST_OTP   one account for the store reviews (both or neither)
//   APP_TEST_ACCOUNTS=email:code,email:code       any number of test accounts, each with its own code
// Never committed, unset by default in .env.example. Leaving all unset disables this path
// entirely and every account uses the normal random OTP.
//
// The codes are deliberately long: they have no expiresIn rotation, so they need more entropy
// than a normal 10-minute-lived 6-digit code to stay safe against brute force. Compared with
// constant-time equality by better-auth's own verifyStoredOTP regardless of length/charset.
// Parsing and validation: fixedOtpAccounts.ts (throws on a misconfiguration).
const FIXED_OTP = parseFixedOtpAccounts({
  reviewEmail:  process.env['APP_REVIEW_TEST_EMAIL'],
  reviewOtp:    process.env['APP_REVIEW_TEST_OTP'],
  testAccounts: process.env['APP_TEST_ACCOUNTS'],
})
for (const w of FIXED_OTP.warnings) console.warn(`[auth] ${w}`)
function fixedOtpFor(email: string | null | undefined): string | null {
  return (email && FIXED_OTP.byEmail.get(email.toLowerCase())) || null
}
/** True for a fixed-code account (review or test): passkeys are disabled for it. */
export function isReviewAccountEmail(email: string | null | undefined): boolean {
  return fixedOtpFor(email) !== null
}

if (!SECRET || SECRET.length < 32) {
  throw new Error('BETTER_AUTH_SECRET must be set and at least 32 characters long')
}
if (!BASE_URL) {
  throw new Error('BETTER_AUTH_URL must be set (e.g. https://api.your-domain.example)')
}

// ---------------------------------------------------------------------------
// better-auth instance
// ---------------------------------------------------------------------------
// API origin + (prod) BETTER_AUTH_TRUSTED_ORIGINS (must include the app's
// own origin, e.g. https://app.<domain>) + (dev only) local origins.
// Exported so /api/admin/* can apply the same Origin check to its writes.
export const TRUSTED_ORIGINS: string[] = [
  BASE_URL,
  ...DEV_TRUSTED_ORIGINS,
  ...(process.env['BETTER_AUTH_TRUSTED_ORIGINS']?.split(',').map(o => o.trim()).filter(Boolean) ?? []),
  ...(ADMIN_APP_ORIGIN ? [ADMIN_APP_ORIGIN] : []),
]

export const auth = betterAuth({
  secret:  SECRET,
  baseURL: BASE_URL,

  trustedOrigins: TRUSTED_ORIGINS,

  // A compromised mailbox (email OTP) alone must never be enough to become
  // admin. Two modes (see admin.ts):
  //   - Cloudflare Access configured (CF_ACCESS_*): Access is the second
  //     factor, verified on every admin request, so OTP sign-in is allowed.
  //   - Otherwise admins are passkey-only: the OTP sign-in route is refused
  //     for any user whose role is 'admin', with the same message as a bad
  //     code so it doesn't reveal which emails are admins.
  // Lost passkey? See docs/self-hosting.md "Admin UI".
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // The shared review/tester account must not gain passkeys: it signs in
      // with a fixed OTP, and a passkey would let one reviewer lock the next
      // out / persist access beyond the review cycle.
      if (ctx.path === '/passkey/generate-register-options' || ctx.path === '/passkey/verify-registration') {
        const session = await getSessionFromCtx(ctx)
        if (isReviewAccountEmail(session?.user.email)) {
          throw APIError.from('FORBIDDEN', { message: 'Passkeys are disabled for this account', code: 'PASSKEY_DISABLED' })
        }
      }
      if (ACCESS_CONFIG) return
      if (ctx.path !== '/sign-in/email-otp') return
      const email = (ctx.body as { email?: unknown } | undefined)?.email
      if (typeof email !== 'string') return
      const { rows } = await pool.query<{ role: string | null }>(
        'SELECT role FROM ba_user WHERE lower(email) = lower($1)', [email.trim()])
      if (rows[0]?.role === 'admin') {
        throw APIError.from('BAD_REQUEST', { message: 'Invalid OTP', code: 'INVALID_OTP' })
      }
    }),
  },

  // ── Rate limiting ────────────────────────────────────────────────────────
  // better-auth only enables this by default when NODE_ENV=production, which
  // the prod container never set -- so OTP send/verify had NO per-IP limit at
  // all in production until this was made explicit. Keep enabled regardless
  // of NODE_ENV; dev can raise limits via customRules if it ever gets in the way.
  // Default sign-in/OTP special rules in better-auth are stricter than this
  // baseline (they apply on top). In-memory store is fine for one instance.
  rateLimit: {
    enabled: true,
    window:  60,
    max:     60,
    customRules: {
      // Every send = one Brevo email on our account. 3/min/IP is plenty for
      // a human retrying a typo; stops an IP from using us as a mail cannon.
      '/email-otp/send-verification-otp': { window: 60, max: 3 },
      // 6-digit code, 10-minute life: better-auth caps attempts per code
      // (allowedAttempts), this caps attempts per IP across codes.
      '/sign-in/email-otp':               { window: 60, max: 10 },
      '/email-otp/verify-email':          { window: 60, max: 10 },
      '/email-otp/check-verification-otp': { window: 60, max: 10 },
      '/passkey/verify-authentication':   { window: 60, max: 20 },
      '/delete-user':                     { window: 3600, max: 3 },
    },
  },

  advanced: {
    // Only trust the edge-asserted client IP. nginx forwards CF-Connecting-IP
    // as X-Real-IP / X-Forwarded-For (replacing, not appending) -- reading
    // any other header here would let a client choose its own rate-limit
    // bucket. See docker/nginx.prod.conf ($client_ip map) in the infra repo.
    ipAddress: {
      ipAddressHeaders: ['cf-connecting-ip', 'x-real-ip'],
    },
    ...(COOKIE_DOMAIN ? {
      crossSubDomainCookies: { enabled: true, domain: COOKIE_DOMAIN },
    } : {}),
    // Cookie flags for the cross-subdomain (app.<d> -> api.<d>) fetches with
    // credentials: 'include'. Only meaningful over https, i.e. prod.
    ...(IS_PROD ? { defaultCookieAttributes: { secure: true, httpOnly: true, sameSite: 'lax' as const } } : {}),
  },

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
    // Adds ba_user.role/banned/banReason/banExpires + ba_session.impersonatedBy
    // (db/migrations/20260930000000_admin_plugin.sql). Enforces bans on every
    // session creation (OTP + passkey). Its HTTP endpoints are NOT exposed
    // (index.ts 404s /api/auth/admin/*); only our /api/admin router calls
    // auth.api.* server-side, after its own admin check. Admin = role 'admin',
    // set by hand in the DB (see docs/self-hosting.md).
    admin(),
    passkey({
      rpID:   RP_ID,
      rpName: 'OpenVFR',
      // Every origin a WebAuthn client may present in clientDataJSON:
      //   - web:     the app origin (https://app.<domain>)
      //   - iOS:     native ASAuthorization reports `https://<rpID>` -- the
      //              associated (apex) domain, NOT the web app's subdomain
      //   - Android: android:apk-key-hash:<b64url sha256 of signing cert>,
      //              one per signing cert (Play App Signing key, upload key,
      //              debug/dev-build key) -- comma-separated in
      //              ANDROID_PASSKEY_ORIGIN. Must mirror the fingerprint list
      //              in assetlinks.json (see .env.example).
      origin: Array.from(new Set([
        APP_ORIGIN,
        `https://${RP_ID}`,
        ...(ADMIN_APP_ORIGIN ? [ADMIN_APP_ORIGIN] : []),
        ...(process.env['ANDROID_PASSKEY_ORIGIN'] ?? '')
          .split(',').map(o => o.trim()).filter(Boolean),
      ])),
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
        return fixedOtpFor(email) ?? undefined
      },
      // Sent via Brevo (see mailer.ts). Falls back to a console log when
      // BREVO_API_KEY / BREVO_SENDER_EMAIL are unset, e.g. in local dev.
      sendVerificationOTP: async ({ email, otp }) => {
        // Skip sending for the review account — reviewer never sees this
        // email, they type the fixed code straight from review notes.
        if (fixedOtpFor(email)) {
          return
        }
        await sendEmail({
          to: email,
          subject: 'Your OpenVFR sign-in code',
          text: `Your verification code is: ${otp}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.`,
        })
      },
      otpLength:  6,
      expiresIn:  600,  // 10 minutes
    }),
  ],
})

export type Auth = typeof auth
