/**
 * better-auth plugins for the assistant connection (OAuth 2.1 provider for
 * MCP clients). In its own module, without side effects, so the end-to-end
 * test runs the exact production configuration (see mcp.e2e.test.ts).
 */
import { jwt } from 'better-auth/plugins'
import { mcp } from '@better-auth/mcp'
import { cimd } from '@better-auth/cimd'
import { assistantRevokePlugin, type Query } from './assistantAccess.js'
import { fetchClientMetadataResource } from '@better-auth/cimd/node'

/** Read public aviation data and briefings. Every assistant token carries it. */
export const SCOPE_BRIEFING = 'briefing:read'
/** Read the user's saved routes and aircraft profiles (a separate consent). */
export const SCOPE_ROUTES = 'routes:read'
/** Create and change the user's aircraft profiles (a separate consent, off by default on the consent page). */
export const SCOPE_AIRCRAFT_WRITE = 'aircraft:write'
/** Create and change routes and saved places (a separate consent, off by default on the consent page). */
export const SCOPE_ROUTES_WRITE = 'routes:write'
/** Read flight summaries from the logbook: dates, times, aerodromes, distances. Never GPS tracks (a separate consent). */
export const SCOPE_LOGS = 'logs:read'
export const MCP_SCOPES = ['openid', 'offline_access', SCOPE_BRIEFING, SCOPE_ROUTES, SCOPE_ROUTES_WRITE, SCOPE_AIRCRAFT_WRITE, SCOPE_LOGS]

/** Paths better-auth rate-limits for the assistant connection (open client registration). */
export const ASSISTANT_RATE_RULES = {
  '/oauth2/register': { window: 3600, max: 10 },
} as const

/** The MCP endpoint (protected resource) for an api origin. */
export function mcpResource(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/mcp`
}

/**
 * Plugins that make the api an OAuth provider for MCP clients. Sign-in and
 * consent are pages of the web app at `appOrigin`. Assistants identify with a
 * Client ID Metadata Document (CIMD) or by open Dynamic Client Registration;
 * either way a client only gets tokens for the MCP endpoint, after a user
 * signs in and approves it.
 */
export function assistantConnectionPlugins(opts: { baseUrl: string; appOrigin: string; query: Query }) {
  return [
    // Disconnecting an assistant also ends its tokens (see assistantAccess.ts).
    assistantRevokePlugin(opts.query),
    // Signing keys for the assistant access tokens (JWKS at /api/auth/jwks).
    jwt({ disableSettingJwtHeader: true, schema: { jwks: { modelName: 'ba_jwks' } } }),
    mcp({
      resource:    mcpResource(opts.baseUrl),
      loginPage:   `${opts.appOrigin}/oauth/login`,
      consentPage: `${opts.appOrigin}/oauth/consent`,
      scopes:      MCP_SCOPES,
      // Nobody manages OAuth clients through the api's own client endpoints (create-client, update-client,
      // delete-client, ...): assistants register themselves at /oauth2/register (no session involved) or by
      // metadata document. Without this hook every signed-in user could create and change clients over HTTP.
      clientPrivileges: () => false,
      allowDynamicClientRegistration:        true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultApplicationType: 'infer',
      clientRegistrationDefaultScopes: MCP_SCOPES,
      clientRegistrationAllowedScopes: MCP_SCOPES,
      // Short access tokens; refresh tokens rotate, unused for 90 days = gone.
      accessTokenExpiresIn:  60 * 60,
      refreshTokenExpiresIn: 90 * 24 * 60 * 60,
      // A replayed refresh token is treated as theft (no reuse window).
      refreshTokenReuseInterval: 0,
      schema: {
        oauthClient:          { modelName: 'ba_oauth_client' },
        oauthAccessToken:     { modelName: 'ba_oauth_access_token' },
        oauthRefreshToken:    { modelName: 'ba_oauth_refresh_token' },
        oauthConsent:         { modelName: 'ba_oauth_consent' },
        oauthClientAssertion: { modelName: 'ba_oauth_client_assertion' },
        oauthResource:        { modelName: 'ba_oauth_resource' },
        oauthClientResource:  { modelName: 'ba_oauth_client_resource' },
      },
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
  ]
}
