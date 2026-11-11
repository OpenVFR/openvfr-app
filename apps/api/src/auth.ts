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
import { assistantConnectionPlugins, mcpResource, ASSISTANT_RATE_RULES, SCOPE_BRIEFING, SCOPE_ROUTES, SCOPE_AIRCRAFT_WRITE } from './assistantAuth.js'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { sendEmail }  from './mailer.js'
import { pool }        from './db.js'
import { ACCESS_CONFIG } from './accessJwt.js'
import { RateLimiter, limitFromEnv } from './rateLimiter.js'

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
export const APP_ORIGIN = process.env['BETTER_AUTH_APP_ORIGIN'] || BASE_URL || 'http://localhost:5173'
const IS_PROD = process.env['NODE_ENV'] === 'production'

// ── Assistant connection (MCP) ────────────────────────────────────────────
// Opt-in (ASSISTANT_MCP=on): turns the api into an OAuth 2.1 authorization
// server for the pilot's own AI assistant (an MCP client) and protects the
// read-only MCP endpoint at <BETTER_AUTH_URL>/mcp. Sign-in and consent are
// pages of the web app (BETTER_AUTH_APP_ORIGIN). Assistants identify
// themselves with a Client ID Metadata Document (CIMD) or, for clients that
// still need it, by open Dynamic Client Registration (rate limited; such a
// client can only ever get tokens for the MCP endpoint, and only after the
// user signs in and approves it).
export const ASSISTANT_MCP = /^(on|true|1)$/i.test(process.env['ASSISTANT_MCP'] ?? '')
export const MCP_RESOURCE = mcpResource(BASE_URL ?? '')
export { SCOPE_BRIEFING, SCOPE_ROUTES, SCOPE_AIRCRAFT_WRITE }

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

// Cookie name prefix (default 'better-auth'). Two deployments sharing one
// parent cookie domain must use different prefixes: the browser sends both
// deployments' cookies to every host under that domain, and with equal names
// one deployment could read the other's session.
const COOKIE_PREFIX = process.env['BETTER_AUTH_COOKIE_PREFIX']?.trim() || ''

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
// docker-compose.yml's local-dev fallback secret is public (it's in this
// repo). It also signs PostgREST JWTs, so anyone could mint tokens for any
// user's data. Refuse it for any deployment served over https -- local dev
// runs on http://localhost and keeps working without a .env.
export const DEV_FALLBACK_SECRET = 'dev_secret_change_in_production_32ch'
if (SECRET === DEV_FALLBACK_SECRET && BASE_URL.startsWith('https://')) {
  throw new Error('BETTER_AUTH_SECRET is the public docker-compose dev default; set a random 32+ char secret (e.g. `openssl rand -base64 48`)')
}

// ---------------------------------------------------------------------------
// Daily caps on sign-in code emails, on top of better-auth's per-minute rule
// (rateLimit.customRules below). Per client IP: stops one source from using
// us as a mail cannon / exhausting the mail provider quota slowly. Per
// address: stops anyone (from many IPs) flooding one inbox. Fixed-code
// accounts never get an email and are exempt.
// ---------------------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000
const otpSendsPerIp = new RateLimiter([
  { windowMs: DAY_MS, max: limitFromEnv('OTP_SENDS_PER_IP_DAILY', 30) },
])
const otpSendsPerEmail = new RateLimiter([
  { windowMs: DAY_MS, max: limitFromEnv('OTP_SENDS_PER_EMAIL_DAILY', 10) },
])

/** Same trusted client-IP headers as advanced.ipAddress below; null when absent (local dev). */
function trustedClientIp(headers: Headers | undefined): string | null {
  return headers?.get('cf-connecting-ip')?.trim() || headers?.get('x-real-ip')?.trim() || null
}

function enforceOtpSendCaps(headers: Headers | undefined, email: string): void {
  if (fixedOtpFor(email)) return
  const ip = trustedClientIp(headers)
  // Check both before recording either, so a refusal doesn't charge the other.
  const blocked = (ip && otpSendsPerIp.check(ip).waitS > 0) || otpSendsPerEmail.check(email).waitS > 0
  if (blocked) {
    throw APIError.from('TOO_MANY_REQUESTS', {
      message: 'Too many sign-in codes requested today. Try again later or sign in with a passkey.',
      code: 'OTP_DAILY_LIMIT',
    })
  }
  if (ip) otpSendsPerIp.record(ip)
  otpSendsPerEmail.record(email)
}

// Session lifetimes. Web (cookie): 30 days sliding. Native (bearer token): 365
// days sliding, like SkyDemon, so pilots aren't signed out between seasons.
const WEB_SESSION_S    = 60 * 60 * 24 * 30
const NATIVE_SESSION_S = 60 * 60 * 24 * 365
/** Request header the native app sends on every auth call (utils/authClient.ts). */
const NATIVE_CLIENT_HEADER = 'x-openvfr-client'
/**
 * True for a sign-in from the native app. The header is self-declared, so it
 * is only honoured when no browser fingerprint is present: browsers always add
 * Sec-Fetch-* headers to fetch/XHR and page JS cannot set or remove them, while
 * React Native sends none. A script (curl) can still claim it, but it must
 * complete its own OTP/passkey sign-in first, so it only lengthens its own
 * session. The decision is stored on the session row (ba_session.client) at
 * creation and read from there afterwards, never from later requests.
 */
function isNativeSignIn(ctx: { headers?: Headers; request?: Request } | null | undefined): boolean {
  const h = ctx?.headers ?? ctx?.request?.headers
  return h?.get(NATIVE_CLIENT_HEADER) === 'native' && !h.has('sec-fetch-site') && !h.has('sec-fetch-mode')
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

/**
 * After an approved assistant connection, email the account owner: a
 * connection they did not make (stolen session, phishing) then does not go
 * unnoticed. Best effort: a failed email never fails the consent.
 */
async function notifyAssistantConnected(ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]): Promise<void> {
  try {
    const body = (ctx.body ?? {}) as { accept?: unknown; scope?: unknown; oauth_query?: unknown }
    const returned = ctx.context.returned as { url?: unknown } | null | undefined
    if (body.accept !== true || !returned || typeof returned.url !== 'string') return
    const session = await getSessionFromCtx(ctx)
    if (!session?.user.email) return
    const query = new URLSearchParams(typeof body.oauth_query === 'string' ? body.oauth_query : '')
    const clientId = query.get('client_id') ?? ''
    const scopes = (typeof body.scope === 'string' ? body.scope : query.get('scope') ?? '').split(' ')
    const { rows } = await pool.query<{ name: string | null }>('SELECT name FROM ba_oauth_client WHERE "clientId" = $1', [clientId])
    const name = rows[0]?.name || 'An AI assistant'
    let who = 'not verified: it registered itself and chose its own name'
    if (/^https:\/\//i.test(clientId)) { try { who = `verified: published by ${new URL(clientId).host}` } catch { /* keep */ } }
    const reads = scopes.includes(SCOPE_ROUTES) ? 'briefings, aerodromes, weather and NOTAMs, and your saved routes and aircraft' : 'briefings, aerodromes, weather and NOTAMs'
    const writes = scopes.includes(SCOPE_AIRCRAFT_WRITE) ? 'It can also add and change your aircraft profiles (never delete them); each change is marked "check before use" in the app.' : 'It cannot change anything.'
    await sendEmail({
      to: session.user.email,
      subject: `${name} was connected to your OpenVFR account`,
      text: `${name} (${who}) was connected to your OpenVFR account (${session.user.email}) at ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.\n\nIt can read: ${reads}. ${writes}\n\nIf this wasn't you: open OpenVFR, your account, AI assistants, and choose Disconnect. Then sign out on your devices.`,
    })
  } catch (err) {
    console.warn('[auth] assistant connection email failed:', err)
  }
}

export const auth = betterAuth({
  secret:  SECRET,
  // The JWT plugin's own /token route would shadow nothing useful here and
  // mint session JWTs with the access tokens' signing key: off.
  ...(ASSISTANT_MCP ? { disabledPaths: ['/token'] } : {}),
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
      if (ctx.path === '/email-otp/send-verification-otp') {
        const email = (ctx.body as { email?: unknown } | undefined)?.email
        if (typeof email === 'string') enforceOtpSendCaps(ctx.headers, email.trim().toLowerCase())
        return
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
    // Sliding window for native sessions (see `session` above): on every
    // validated /get-session, push expiresAt back out to 365 days once it has
    // slipped more than a day (also undoes better-auth's own 30-day refresh).
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/oauth2/consent') { await notifyAssistantConnected(ctx); return }
      if (ctx.path !== '/get-session') return
      const returned = ctx.context.returned as { session?: { token: string; client?: string | null; expiresAt: Date | string } } | null | undefined
      const sess = returned?.session
      if (!sess || sess.client !== 'native') return
      const target = Date.now() + NATIVE_SESSION_S * 1000
      if (target - new Date(sess.expiresAt).getTime() < 24 * 60 * 60 * 1000) return
      await ctx.context.internalAdapter.updateSession(sess.token, {
        expiresAt: new Date(target), updatedAt: new Date(),
      })
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
      // Every send = one billed email on our account. 3/min/IP is plenty for
      // a human retrying a typo; stops an IP from using us as a mail cannon.
      '/email-otp/send-verification-otp': { window: 60, max: 3 },
      // 6-digit code, 10-minute life: better-auth caps attempts per code
      // (allowedAttempts), this caps attempts per IP across codes.
      '/sign-in/email-otp':               { window: 60, max: 10 },
      '/email-otp/verify-email':          { window: 60, max: 10 },
      '/email-otp/check-verification-otp': { window: 60, max: 10 },
      '/passkey/verify-authentication':   { window: 60, max: 20 },
      '/delete-user':                     { window: 3600, max: 3 },
      // Open client registration for assistants that cannot use CIMD.
      ...ASSISTANT_RATE_RULES,
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
    ...(COOKIE_PREFIX ? { cookiePrefix: COOKIE_PREFIX } : {}),
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
  // better-auth has one global expiresIn (web: 30 days) and refreshes only in
  // the last (expiresIn - updateAge) of a session, so native sessions get their
  // 365 days from databaseHooks (create) and are re-extended on use by the
  // /get-session hook in `hooks.after` below.
  session: {
    modelName: 'ba_session',
    expiresIn: WEB_SESSION_S,
    updateAge: 60 * 60 * 24,
    additionalFields: {
      client: { type: 'string', required: false, input: false },
    },
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session, ctx) => (isNativeSignIn(ctx)
          ? { data: { ...session, client: 'native', expiresAt: new Date(Date.now() + NATIVE_SESSION_S * 1000) } }
          : undefined),
      },
    },
  },
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
      // Sent via Azure Communication Services (see mailer.ts). Falls back to a console log when
      // no email provider is configured, e.g. in local dev.
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
    ...(ASSISTANT_MCP ? assistantConnectionPlugins({ baseUrl: BASE_URL, appOrigin: APP_ORIGIN }) : []),
  ],
})

export type Auth = typeof auth
