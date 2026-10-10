/**
 * Admin API -- /api/admin/*  (web admin UI at /admin).
 *
 * Security model (see AGENTS.md "Server API Security Baseline"):
 *   - AUTH: every route requires a valid session whose user has
 *     ba_user.role = 'admin' (set by hand in the DB; nothing here can grant
 *     it). Non-admins get 403.
 *   - SECOND FACTOR, one of two modes (a mailbox takeover alone is never enough):
 *       a) CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD set: every request needs a
 *          valid Cloudflare Access JWT whose email matches the admin
 *          (accessJwt.ts). Email-OTP sign-in is allowed.
 *       b) otherwise passkey-only: the admin needs >=1 registered passkey,
 *          and OTP sign-in is refused for admin accounts (auth.ts hooks).
 *     Either way the session must be younger than ADMIN_MAX_SESSION_HOURS
 *     (default 12); older ones must sign in again.
 *   - ORIGIN: if ADMIN_APP_ORIGIN is set, a request carrying any other Origin
 *     is rejected, and writes must carry it. Unset = auth's trusted origins.
 *   - RATE LIMIT: per-admin sliding window (ADMIN_RATE_PER_MIN, default 120).
 *   - CSRF: state-changing methods additionally require an `Origin` header in
 *     the trusted-origins list (same list better-auth uses).
 *   - DATA: aggregate counts + account metadata from the ba_* tables only.
 *     No user content (routes, positions, flight logs) and no IP addresses
 *     are exposed; the api_app role couldn't read user content anyway.
 *   - BANS: better-auth admin plugin (auth.api.banUser / unbanUser), called
 *     server-side; the plugin's own HTTP endpoints are not exposed.
 *   - Responses are `Cache-Control: no-store`.
 */

import { Hono, type MiddlewareHandler } from 'hono'
import { auth, TRUSTED_ORIGINS, ADMIN_APP_ORIGIN } from './auth.js'
import { ACCESS_CONFIG, createAccessVerifier } from './accessJwt.js'
import { pool } from './db.js'
import { invalidateCountries } from './countries.js'
import { EUROPEAN_REGIONS, isSupportedRegion } from '@open-vfr/shared/regions'

const MAX_SESSION_MS = Number(process.env['ADMIN_MAX_SESSION_HOURS'] ?? 12) * 3_600_000
const verifyAccess = ACCESS_CONFIG ? createAccessVerifier(ACCESS_CONFIG) : null
if (ACCESS_CONFIG) console.log(`[admin] Cloudflare Access required (${ACCESS_CONFIG.issuer})`)

const RATE_PER_MIN = Number(process.env['ADMIN_RATE_PER_MIN'] ?? 120)

const hits = new Map<string, number[]>() // admin user id -> request timestamps (last 60 s)
function rateLimited(userId: string): boolean {
  const now = Date.now()
  const recent = (hits.get(userId) ?? []).filter(t => now - t < 60_000)
  if (recent.length >= RATE_PER_MIN) { hits.set(userId, recent); return true }
  recent.push(now)
  hits.set(userId, recent)
  return false
}

type AdminEnv = { Variables: { adminEmail: string; adminHeaders: Headers } }

const requireAdmin: MiddlewareHandler<AdminEnv> = async (c, next) => {
  c.header('Cache-Control', 'no-store')

  // Origin first, before any DB/session work. Browsers always send Origin on
  // cross-origin fetches, so this stops script on any other origin (e.g. the
  // main app, which shares the session cookie) at the server, not only via CORS.
  const origin = c.req.header('origin')
  const isWrite = c.req.method !== 'GET' && c.req.method !== 'HEAD'
  const allowed = ADMIN_APP_ORIGIN ? [ADMIN_APP_ORIGIN] : TRUSTED_ORIGINS
  if (origin ? !allowed.includes(origin) : isWrite) return c.json({ error: 'Bad origin' }, 403)

  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: 'Unauthenticated' }, 401)
  const { id, email, role } = session.user as { id: string; email: string; role?: string | null }
  if (role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  // Past this point the caller is a confirmed admin, so specific codes are
  // safe to return (the UI uses them to explain what to do).
  const created = new Date(session.session.createdAt).getTime()
  if (!(Date.now() - created < MAX_SESSION_MS)) {
    return c.json({ error: 'Admin session expired; sign in again with your passkey', code: 'reauth_required' }, 403)
  }
  if (verifyAccess) {
    const r = await verifyAccess(c.req.header('cf-access-jwt-assertion'), email)
    if (!r.ok) {
      console.warn(`[admin] Access check failed for ${email}: ${r.reason}`)
      return c.json({ error: 'Cloudflare Access login required for this account', code: 'access_required' }, 403)
    }
  } else {
    const pk = await pool.query('SELECT 1 FROM ba_passkey WHERE "userId" = $1 LIMIT 1', [id])
    if (!pk.rowCount) {
      return c.json({ error: 'Register a passkey on this account first', code: 'passkey_required' }, 403)
    }
  }

  if (rateLimited(id)) return c.json({ error: 'Too many requests' }, 429)

  c.set('adminEmail', email.toLowerCase())
  c.set('adminHeaders', c.req.raw.headers)
  await next()
}

export const admin = new Hono<AdminEnv>()
admin.use('*', requireAdmin)

// GET /api/admin/me -- lets the UI decide whether to render (200) or not.
admin.get('/me', (c) => c.json({ email: c.get('adminEmail'), mode: verifyAccess ? 'access' : 'passkey' }))

// GET /api/admin/overview -- KPIs + 30-day series.
admin.get('/overview', async (c) => {
  const [totals, signups, active] = await Promise.all([
    pool.query(`
      SELECT
        (SELECT count(*) FROM ba_user)::int                                                 AS users,
        (SELECT count(*) FROM ba_user WHERE "emailVerified")::int                           AS verified,
        (SELECT count(*) FROM ba_user WHERE "createdAt" > now() - interval '7 days')::int   AS new_7d,
        (SELECT count(*) FROM ba_user WHERE "createdAt" > now() - interval '30 days')::int  AS new_30d,
        (SELECT count(DISTINCT "userId") FROM ba_passkey)::int                              AS with_passkey,
        (SELECT count(*) FROM ba_session WHERE "expiresAt" > now())::int                    AS active_sessions,
        (SELECT count(DISTINCT "userId") FROM ba_session WHERE "updatedAt" > now() - interval '1 day')::int   AS active_1d,
        (SELECT count(DISTINCT "userId") FROM ba_session WHERE "updatedAt" > now() - interval '7 days')::int  AS active_7d,
        (SELECT count(DISTINCT "userId") FROM ba_session WHERE "updatedAt" > now() - interval '30 days')::int AS active_30d,
        (SELECT count(*) FROM ba_user WHERE banned)::int                                      AS banned
    `),
    pool.query(`
      SELECT to_char(d::date, 'YYYY-MM-DD') AS day, coalesce(n, 0)::int AS count
      FROM generate_series(current_date - 29, current_date, '1 day') d
      LEFT JOIN (SELECT "createdAt"::date AS day, count(*) AS n FROM ba_user GROUP BY 1) u ON u.day = d::date
      ORDER BY d
    `),
    pool.query(`
      SELECT to_char(d::date, 'YYYY-MM-DD') AS day, coalesce(n, 0)::int AS count
      FROM generate_series(current_date - 29, current_date, '1 day') d
      LEFT JOIN (SELECT "updatedAt"::date AS day, count(DISTINCT "userId") AS n FROM ba_session GROUP BY 1) s
        ON s.day = d::date
      ORDER BY d
    `),
  ])
  return c.json({ totals: totals.rows[0], signupsPerDay: signups.rows, activePerDay: active.rows })
})

const SORTS: Record<string, string> = {
  created:    'u."createdAt" DESC',
  lastActive: 'last_active DESC NULLS LAST',
  email:      'u.email ASC',
}

// GET /api/admin/users?q=&sort=created|lastActive|email&limit=&offset=
admin.get('/users', async (c) => {
  const q      = (c.req.query('q') ?? '').trim().toLowerCase().slice(0, 100)
  const order  = SORTS[c.req.query('sort') ?? 'created'] ?? SORTS['created']!
  const limit  = Math.min(Math.max(Number(c.req.query('limit')  ?? 50) | 0, 1), 200)
  const offset = Math.max(Number(c.req.query('offset') ?? 0) | 0, 0)
  const like   = `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`

  const bannedOnly = c.req.query('banned') === '1'
  const { rows } = await pool.query(`
    SELECT u.id, u.email, u.name, u."emailVerified", u."createdAt",
           (SELECT count(*) FROM ba_passkey p WHERE p."userId" = u.id)::int                           AS passkeys,
           (SELECT count(*) FROM ba_session s WHERE s."userId" = u.id AND s."expiresAt" > now())::int AS sessions,
           (SELECT max(s."updatedAt") FROM ba_session s WHERE s."userId" = u.id)                      AS last_active,
           u.banned, u.role,
           count(*) OVER ()::int                                                                      AS total
    FROM ba_user u
    WHERE ($1 = '' OR lower(u.email) LIKE $2 OR lower(u.name) LIKE $2)
      AND (NOT $5::boolean OR u.banned)
    ORDER BY ${order}
    LIMIT $3 OFFSET $4
  `, [q, like, limit, offset, bannedOnly])

  return c.json({
    total: rows[0]?.total ?? 0,
    users: rows.map(r => ({
      id: r.id, email: r.email, name: r.name, emailVerified: r.emailVerified,
      createdAt: r.createdAt, passkeys: r.passkeys, sessions: r.sessions,
      lastActive: r.last_active, banned: r.banned, isAdmin: r.role === 'admin',
    })),
  })
})

// GET /api/admin/users/:id -- account detail: sessions (no IPs) + passkeys.
admin.get('/users/:id', async (c) => {
  const id = c.req.param('id')
  const user = await pool.query(
    `SELECT id, email, name, "emailVerified", "createdAt", "updatedAt", role, banned, "banReason", "banExpires"
     FROM ba_user WHERE id = $1`, [id])
  const u = user.rows[0]
  if (!u) return c.json({ error: 'Not found' }, 404)
  const [sessions, passkeys] = await Promise.all([
    pool.query(`SELECT id, "createdAt", "updatedAt", "expiresAt", "userAgent"
                FROM ba_session WHERE "userId" = $1 ORDER BY "updatedAt" DESC LIMIT 50`, [id]),
    pool.query(`SELECT id, name, "deviceType", "backedUp", "createdAt"
                FROM ba_passkey WHERE "userId" = $1 ORDER BY "createdAt" DESC`, [id])
  ])
  return c.json({
    user: { ...u, isAdmin: u.role === 'admin' },
    sessions: sessions.rows, passkeys: passkeys.rows,
  })
})

// POST /api/admin/users/:id/ban { reason?, days? } -- ban (revokes all sessions;
// blocks sign-in until unbanned or expiry). `days` omitted = permanent.
admin.post('/users/:id/ban', async (c) => {
  const id   = c.req.param('id')
  const body = await c.req.json().catch(() => null) as { reason?: unknown; days?: unknown } | null
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : ''
  const days   = typeof body?.days === 'number' && body.days > 0 && body.days <= 3650 ? body.days : undefined

  const target = await pool.query('SELECT email, role FROM ba_user WHERE id = $1', [id])
  if (!target.rows[0]) return c.json({ error: 'Not found' }, 404)
  if (target.rows[0].role === 'admin') return c.json({ error: 'Admins cannot be banned' }, 400)

  await auth.api.banUser({
    headers: c.get('adminHeaders'),
    body: { userId: id, banReason: reason || undefined, banExpiresIn: days ? days * 86400 : undefined },
  })
  console.log(`[admin] ${c.get('adminEmail')} banned ${target.rows[0].email}${days ? ` for ${days}d` : ''}`)
  return c.json({ ok: true })
})

// POST /api/admin/users/:id/unban
admin.post('/users/:id/unban', async (c) => {
  const id = c.req.param('id')
  await auth.api.unbanUser({ headers: c.get('adminHeaders'), body: { userId: id } })
  console.log(`[admin] ${c.get('adminEmail')} unbanned user ${id}`)
  return c.json({ ok: true })
})

// GET /api/admin/countries -- every supported country with its registry
// state (see db/migrations/20261001000000_countries.sql). `available` is what
// clients see: enabled AND built by the data pipeline.
admin.get('/countries', async (c) => {
  const { rows } = await pool.query<{
    code: string; enabled: boolean; enabled_at: Date | null; tiles_ready_at: Date | null; last_error: string | null
  }>('SELECT code, enabled, enabled_at, tiles_ready_at, last_error FROM countries')
  const byCode = new Map(rows.map(r => [r.code.trim(), r]))
  return c.json({
    // Only countries openflightmaps publishes data for (SUPPORTED_REGION_CODES).
    countries: EUROPEAN_REGIONS.filter(({ code }) => isSupportedRegion(code)).map(({ code, name }) => {
      const r = byCode.get(code)
      return {
        code, name,
        enabled:      r?.enabled ?? false,
        enabledAt:    r?.enabled_at ?? null,
        tilesReadyAt: r?.tiles_ready_at ?? null,
        lastError:    r?.last_error ?? null,
        available:    !!r?.enabled && !!r.tiles_ready_at,
      }
    }),
  })
})

// PUT /api/admin/countries/:code { enabled: boolean } -- enable/disable a
// country. Enabling a country without data queues it for the pipeline's
// next backfill run (it becomes available once tiles_ready_at is set);
// re-enabling one whose data still exists makes it available at once.
admin.put('/countries/:code', async (c) => {
  const code = c.req.param('code').toLowerCase()
  if (!isSupportedRegion(code)) return c.json({ error: 'Unsupported country (no openflightmaps data)' }, 404)
  const body = await c.req.json().catch(() => null) as { enabled?: unknown } | null
  if (typeof body?.enabled !== 'boolean') return c.json({ error: 'Body must be { enabled: boolean }' }, 400)
  await pool.query(`
    INSERT INTO countries (code, enabled, enabled_at, updated_at)
    VALUES ($1, $2, CASE WHEN $2 THEN now() END, now())
    ON CONFLICT (code) DO UPDATE SET
      enabled    = EXCLUDED.enabled,
      enabled_at = CASE WHEN EXCLUDED.enabled AND NOT countries.enabled THEN now() ELSE countries.enabled_at END,
      updated_at = now()
  `, [code, body.enabled])
  invalidateCountries()
  console.log(`[admin] ${c.get('adminEmail')} ${body.enabled ? 'enabled' : 'disabled'} country ${code}`)
  return c.json({ ok: true })
})
