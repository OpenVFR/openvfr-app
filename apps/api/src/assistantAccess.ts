/**
 * What ends an assistant's access, beyond token expiry: disconnecting it,
 * and banning the account. better-auth's `delete-consent` removes only the
 * consent row and its refresh grant never looks at consent or bans, so
 * without this an assistant keeps refreshing for 90 days after the pilot
 * disconnected it or an admin banned them.
 *
 *  - `revokeAssistantTokens`: deletes the refresh and access tokens of a
 *    user (all assistants, or one client).
 *  - `assistantRevokePlugin`: runs that when a pilot deletes a consent.
 *  - `createAssistantAccess`: the /mcp handler asks, per request (cached for
 *    a few seconds), whether the user is not banned and still has a consent
 *    for the client, so access tokens (1 h) die with the consent too.
 *  - `cleanupAssistantTables`: deletes expired tokens and abandoned clients (see there).
 *  - `assistantClientName`: the client's own name, cleaned for use in review
 *    marks and emails (it is chosen by whoever registered the client).
 */
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'

export type Query = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>

export async function revokeAssistantTokens(query: Query, userId: string, clientId?: string): Promise<void> {
  const [where, params] = clientId ? ['"userId" = $1 AND "clientId" = $2', [userId, clientId]] : ['"userId" = $1', [userId]]
  try {
    await query(`DELETE FROM ba_oauth_access_token WHERE ${where}`, params)
    await query(`DELETE FROM ba_oauth_refresh_token WHERE ${where}`, params)
  } catch (err) {
    // The tables come with the assistant migration: a deployment that has not applied it has no tokens to end
    // (and a ban must not fail because of that).
    if ((err as { code?: string }).code === '42P01') return
    throw err
  }
}

/** Deleting a consent also deletes the tokens that came from it (only the signed-in user's own). */
export function assistantRevokePlugin(query: Query) {
  return {
    id: 'assistant-revoke',
    hooks: {
      before: [{
        matcher: (ctx: { path?: string }) => ctx.path === '/oauth2/delete-consent',
        handler: createAuthMiddleware(async (ctx) => {
          const session = await getSessionFromCtx(ctx)
          const id = (ctx.body as { id?: unknown } | undefined)?.id
          if (!session?.user || typeof id !== 'string') return
          const { rows } = await query('SELECT "clientId", "userId" FROM ba_oauth_consent WHERE id = $1', [id])
          const row = rows[0]
          if (!row || row['userId'] !== session.user.id) return
          try {
            await revokeAssistantTokens(query, session.user.id, String(row['clientId']))
          } catch (err) {
            console.error('[assistant] revoking tokens failed:', err)
            throw APIError.from('INTERNAL_SERVER_ERROR', { message: 'Could not disconnect the assistant. Try again.', code: 'ASSISTANT_REVOKE_FAILED' })
          }
        }),
      }],
    },
  }
}

/**
 * Per-request check for /mcp: not banned, and the pilot still has a consent for this client.
 * `check` answers the scopes the consent grants right now (null = no access), so a token
 * issued before the pilot narrowed the consent cannot keep its wider scopes.
 */
export function createAssistantAccess(query: Query, ttlMs = 10_000, now: () => number = Date.now) {
  const cache = new Map<string, { at: number; scopes: string[] | null }>()
  async function check(userId: string, clientId: string): Promise<string[] | null> {
    const key = `${userId}\u0000${clientId}`
    const hit = cache.get(key)
    if (hit && now() - hit.at < ttlMs) return hit.scopes
    const { rows } = await query(
      `SELECT u.banned, u."banExpires",
              (SELECT c."scopes" FROM ba_oauth_consent c WHERE c."userId" = u.id AND c."clientId" = $2
                ORDER BY c."updatedAt" DESC LIMIT 1) AS scopes
         FROM ba_user u WHERE u.id = $1`, [userId, clientId])
    const r = rows[0]
    const expires = r?.['banExpires'] ? new Date(String(r['banExpires'])).getTime() : 0
    const banned = r?.['banned'] === true && (!expires || expires > now())
    const granted = Array.isArray(r?.['scopes']) ? (r['scopes'] as unknown[]).filter((x): x is string => typeof x === 'string') : null
    const scopes = !!r && !banned && granted ? granted : null
    if (cache.size > 5000) cache.clear()
    cache.set(key, { at: now(), scopes })
    return scopes
  }
  return {
    check,
    async allowed(userId: string, clientId: string): Promise<boolean> { return (await check(userId, clientId)) !== null },
  }
}

/** The assistant's registered name as plain, short text (it is chosen by the client itself). */
export function cleanClientName(name: string | null | undefined, fallback = 'an AI assistant'): string {
  const n = (name ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029«»]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
  return n || fallback
}

export async function assistantClientName(query: Query, clientId: string, fallback?: string): Promise<string> {
  const { rows } = await query('SELECT name FROM ba_oauth_client WHERE "clientId" = $1', [clientId])
  return cleanClientName(rows[0]?.['name'] as string | null | undefined, fallback)
}

/**
 * Housekeeping for the assistant tables, run daily. Expired or revoked tokens (about one access token an
 * hour per connected assistant) and clients that registered themselves openly but were never approved
 * (or were disconnected) would otherwise stay for ever. A client is kept while it has a consent or a live
 * refresh token; a new registration gets a grace period to finish the sign-in.
 */
export async function cleanupAssistantTables(query: Query): Promise<void> {
  try {
    await query(`DELETE FROM ba_oauth_access_token WHERE "expiresAt" < now() - interval '1 day' OR "revoked" < now() - interval '1 day'`, [])
    await query(`DELETE FROM ba_oauth_refresh_token WHERE "expiresAt" < now() - interval '1 day' OR "revoked" < now() - interval '1 day'`, [])
    await query(
      `DELETE FROM ba_oauth_client c
        WHERE c."createdAt" < now() - interval '14 days'
          AND NOT EXISTS (SELECT 1 FROM ba_oauth_consent k WHERE k."clientId" = c."clientId")
          AND NOT EXISTS (SELECT 1 FROM ba_oauth_refresh_token r WHERE r."clientId" = c."clientId" AND r."revoked" IS NULL AND r."expiresAt" > now())`, [])
  } catch (err) {
    // A deployment that has not applied the assistant migration has nothing to clean.
    if ((err as { code?: string }).code === '42P01') return
    console.error('[assistant] cleanup failed:', err)
  }
}
