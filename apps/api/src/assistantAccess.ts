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
 *  - `assistantClientName`: the client's own name, cleaned for use in review
 *    marks and emails (it is chosen by whoever registered the client).
 */
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'

export type Query = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>

export async function revokeAssistantTokens(query: Query, userId: string, clientId?: string): Promise<void> {
  const [where, params] = clientId ? ['"userId" = $1 AND "clientId" = $2', [userId, clientId]] : ['"userId" = $1', [userId]]
  await query(`DELETE FROM ba_oauth_access_token WHERE ${where}`, params)
  await query(`DELETE FROM ba_oauth_refresh_token WHERE ${where}`, params)
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

/** Per-request check for /mcp: not banned, and the pilot still has a consent for this client. */
export function createAssistantAccess(query: Query, ttlMs = 10_000, now: () => number = Date.now) {
  const cache = new Map<string, { at: number; ok: boolean }>()
  return {
    async allowed(userId: string, clientId: string): Promise<boolean> {
      const key = `${userId}\u0000${clientId}`
      const hit = cache.get(key)
      if (hit && now() - hit.at < ttlMs) return hit.ok
      const { rows } = await query(
        `SELECT u.banned, u."banExpires",
                EXISTS (SELECT 1 FROM ba_oauth_consent c WHERE c."userId" = u.id AND c."clientId" = $2) AS consent
           FROM ba_user u WHERE u.id = $1`, [userId, clientId])
      const r = rows[0]
      const expires = r?.['banExpires'] ? new Date(String(r['banExpires'])).getTime() : 0
      const banned = r?.['banned'] === true && (!expires || expires > now())
      const ok = !!r && !banned && r['consent'] === true
      if (cache.size > 5000) cache.clear()
      cache.set(key, { at: now(), ok })
      return ok
    },
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
