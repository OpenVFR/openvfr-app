/**
 * MCP endpoint for the pilot's own AI assistant (POST /mcp).
 *
 * The assistant reaches it with an access token from the api's OAuth
 * provider (see ASSISTANT_MCP in auth.ts): `requireMcpAuth` verifies the
 * token (signature, issuer, audience = this endpoint, expiry) and answers
 * 401 with the protected-resource metadata link when it is missing, so the
 * assistant can start sign-in. The token's subject is the user; its scopes
 * decide what the tools may do:
 *
 *   briefing:read   public aviation data and briefings (every token)
 *   routes:read     the user's saved routes, places and aircraft profiles;
 *                   every change below needs it too (they read what they change)
 *   routes:write    create and change saved routes and places (never delete)
 *   aircraft:write  create and change aircraft profiles (never delete)
 *   logs:read       per-flight summaries and totals from the logbook (never tracks)
 *
 * Each request also checks that the user is not banned and still has a
 * consent for this assistant (assistantAccess.ts), so disconnecting or a ban
 * ends access at once, not when the token expires.
 *
 * Changes are checked like input in the app, rate-limited, logged and marked
 * for the pilot's review ("check before use") until saved in the app. Answers
 * are short text meant to be read out or summarised, carry the data's age
 * where it has one, link into the app, and end with "not an official
 * briefing" where they brief.
 *
 * The tools live in mcpBriefingTools / mcpAircraftTools / mcpRouteTools /
 * mcpPlaceTools / mcpLogbookTools and the prompts in mcpPrompts, on the shared
 * context of mcpContext.
 */
import { requireMcpAuth } from '@better-auth/mcp'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import type { auth as authInstance } from './auth'
import { RateLimiter, limitFromEnv } from './rateLimiter'
import { DAY_MS, HOUR_MS, createCtx, type McpDeps } from './mcpContext'
import { registerBriefingTools } from './mcpBriefingTools'
import { registerAircraftTools } from './mcpAircraftTools'
import { registerRouteTools } from './mcpRouteTools'
import { registerPlaceTools } from './mcpPlaceTools'
import { registerLogbookTools } from './mcpLogbookTools'
import { registerFlightPlanTool } from './mcpFlightPlanTool'
import { registerPrompts } from './mcpPrompts'

export type { McpDeps } from './mcpContext'

/** Tool calls per user, on top of the briefing and weather limits the tools also use. */
const mcpLimiter = new RateLimiter([
  { windowMs: HOUR_MS, max: limitFromEnv('MCP_HOURLY_LIMIT', 120) },
  { windowMs: DAY_MS,  max: limitFromEnv('MCP_DAILY_LIMIT', 600) },
])

export function createMcpEndpoint(auth: typeof authInstance, deps: McpDeps): (req: Request) => Promise<Response> {
  function buildServer(caller: { userId: string; scopes: string[]; clientId: string }): McpServer {
    const server = new McpServer({ name: 'openvfr', version: '1.0.0' })
    const ctx = createCtx(server, deps, caller)
    registerBriefingTools(ctx)
    registerPrompts(ctx)
    registerAircraftTools(ctx)
    registerPlaceTools(ctx)
    registerLogbookTools(ctx)
    registerFlightPlanTool(ctx)
    registerRouteTools(ctx)
    return server
  }

  const handler = createMcpHandler(({ authInfo }) => {
    const extra = (authInfo?.extra ?? {}) as { sub?: string }
    return buildServer({ userId: extra.sub ?? '', scopes: authInfo?.scopes ?? [], clientId: authInfo?.clientId ?? '' })
  })

  return requireMcpAuth(auth, async (request, claims) => {
    const userId = typeof claims.sub === 'string' ? claims.sub : ''
    if (!userId) return new Response('Forbidden', { status: 403 })
    const clientId = typeof claims['azp'] === 'string' ? claims['azp'] as string : ''
    // Disconnected, or the account banned: the token itself may still be valid for up to an hour.
    let allowed = false
    try { allowed = await deps.access(userId, clientId) } catch (err) { console.error('[mcp] access check failed:', err) }
    if (!allowed) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'This assistant is no longer connected. Connect it again in OpenVFR.' }, id: null }), {
        status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer error="invalid_token"' },
      })
    }
    const limit = mcpLimiter.take(userId)
    if (limit.waitS > 0) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests. Try again later.' }, id: null }), {
        status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(Math.min(limit.waitS, 3600)) },
      })
    }
    const scopes = typeof claims['scope'] === 'string' ? (claims['scope'] as string).split(' ').filter(Boolean) : []
    return handler.fetch(request, {
      authInfo: {
        token: '',
        clientId,
        scopes,
        ...(typeof claims.exp === 'number' ? { expiresAt: claims.exp } : {}),
        extra: { sub: userId },
      },
    })
  }, {
    resource: deps.resource,
    jwksUrl: deps.jwksUrl,
    requiredScopes: [deps.scopeBriefing],
    // Advertised in the 401 challenge: clients ask for what is listed here,
    // so list saved routes (the pilot can still leave them out on the consent
    // page) and offline_access (refresh tokens, no sign-in every hour).
    challengeScopes: [deps.scopeBriefing, deps.scopeRoutes, deps.scopeRoutesWrite, deps.scopeAircraftWrite, deps.scopeLogs, 'offline_access'],
  })
}
