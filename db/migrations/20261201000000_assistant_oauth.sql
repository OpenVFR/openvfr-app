-- migrate:up

-- ════════════════════════════════════════════════════════════════════════════
-- Assistant connection (MCP): OAuth 2.1 authorization server tables.
--
-- A pilot can connect their own AI assistant (an MCP client) to the api's
-- read-only MCP endpoint. better-auth's OAuth provider (with its MCP and
-- Client ID Metadata Document plugins) issues the assistant short-lived,
-- audience-bound access tokens after the pilot signs in and consents.
--
--   ba_jwks                    signing keys (JWT plugin) for access tokens
--   ba_oauth_client            registered or discovered assistants
--   ba_oauth_resource          protected resources (the MCP endpoint)
--   ba_oauth_client_resource   which client may get tokens for which resource
--   ba_oauth_refresh_token     rotating refresh tokens
--   ba_oauth_access_token      issued access tokens (for revocation/introspection)
--   ba_oauth_consent           what each user approved for each assistant
--   ba_oauth_client_assertion  replay protection for client assertions
--
-- Generated from better-auth 1.7.20's own schema (column names and types as
-- its Kysely adapter expects: camelCase, arrays as JSONB). Every user-owned
-- row cascades on ba_user delete, so account deletion removes them too.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ba_jwks (
  "id" text not null primary key,
  "publicKey" text not null,
  "privateKey" text not null,
  "createdAt" timestamptz not null,
  "expiresAt" timestamptz,
  "alg" text,
  "crv" text
);

CREATE TABLE IF NOT EXISTS ba_oauth_client (
  "id" text not null primary key,
  "clientId" text not null unique,
  "clientSecret" text,
  "clientDiscoveryId" text,
  "disabled" boolean,
  "skipConsent" boolean,
  "enableEndSession" boolean,
  "subjectType" text,
  "scopes" jsonb,
  "clientCredentialsScopes" jsonb,
  "userId" text references "ba_user" ("id") on delete cascade,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "name" text,
  "uri" text,
  "icon" text,
  "contacts" jsonb,
  "tos" text,
  "policy" text,
  "softwareId" text,
  "softwareVersion" text,
  "softwareStatement" text,
  "redirectUris" jsonb not null,
  "postLogoutRedirectUris" jsonb,
  "backchannelLogoutUri" text,
  "backchannelLogoutSessionRequired" boolean,
  "tokenEndpointAuthMethod" text,
  "applicationType" text,
  "jwks" text,
  "jwksUri" text,
  "grantTypes" jsonb,
  "responseTypes" jsonb,
  "requirePKCE" boolean,
  "dpopBoundAccessTokens" boolean,
  "referenceId" text,
  "metadata" jsonb
);

CREATE TABLE IF NOT EXISTS ba_oauth_resource (
  "id" text not null primary key,
  "identifier" text not null unique,
  "name" text not null,
  "accessTokenTtl" integer,
  "refreshTokenTtl" integer,
  "signingAlgorithm" text,
  "signingKeyId" text,
  "allowedScopes" jsonb,
  "customClaims" jsonb,
  "dpopBoundAccessTokensRequired" boolean,
  "disabled" boolean,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "policyVersion" integer,
  "metadata" jsonb
);

CREATE TABLE IF NOT EXISTS ba_oauth_client_resource (
  "id" text not null primary key,
  "clientId" text not null references "ba_oauth_client" ("clientId") on delete cascade,
  "resourceId" text not null references "ba_oauth_resource" ("identifier") on delete cascade,
  "metadata" jsonb,
  "createdAt" timestamptz
);

CREATE TABLE IF NOT EXISTS ba_oauth_refresh_token (
  "id" text not null primary key,
  "token" text not null unique,
  "clientId" text not null references "ba_oauth_client" ("clientId") on delete cascade,
  "sessionId" text references "ba_session" ("id") on delete set null,
  "userId" text not null references "ba_user" ("id") on delete cascade,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null,
  "revoked" timestamptz,
  "rotatedAt" timestamptz,
  "rotationReplayResponse" text,
  "rotationReplayExpiresAt" timestamptz,
  "authTime" timestamptz,
  "confirmation" jsonb,
  "scopes" jsonb not null
);

CREATE TABLE IF NOT EXISTS ba_oauth_access_token (
  "id" text not null primary key,
  "token" text not null unique,
  "clientId" text not null references "ba_oauth_client" ("clientId") on delete cascade,
  "sessionId" text references "ba_session" ("id") on delete set null,
  "userId" text references "ba_user" ("id") on delete cascade,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "refreshId" text references "ba_oauth_refresh_token" ("id") on delete cascade,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null,
  "revoked" timestamptz,
  "confirmation" jsonb,
  "scopes" jsonb not null
);

CREATE TABLE IF NOT EXISTS ba_oauth_consent (
  "id" text not null primary key,
  "clientId" text not null references "ba_oauth_client" ("clientId") on delete cascade,
  "userId" text references "ba_user" ("id") on delete cascade,
  "referenceId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "scopes" jsonb not null,
  "createdAt" timestamptz not null,
  "updatedAt" timestamptz not null
);

CREATE TABLE IF NOT EXISTS ba_oauth_client_assertion (
  "id" text not null primary key,
  "expiresAt" timestamptz not null
);

CREATE INDEX IF NOT EXISTS "ba_oauth_client_userId_idx" on "ba_oauth_client" ("userId");
CREATE INDEX IF NOT EXISTS "ba_oauth_client_resource_clientId_idx" on "ba_oauth_client_resource" ("clientId");
CREATE INDEX IF NOT EXISTS "ba_oauth_client_resource_resourceId_idx" on "ba_oauth_client_resource" ("resourceId");
CREATE INDEX IF NOT EXISTS "ba_oauth_refresh_token_clientId_idx" on "ba_oauth_refresh_token" ("clientId");
CREATE INDEX IF NOT EXISTS "ba_oauth_refresh_token_sessionId_idx" on "ba_oauth_refresh_token" ("sessionId");
CREATE INDEX IF NOT EXISTS "ba_oauth_refresh_token_userId_idx" on "ba_oauth_refresh_token" ("userId");
CREATE INDEX IF NOT EXISTS "ba_oauth_refresh_token_authorizationCodeId_idx" on "ba_oauth_refresh_token" ("authorizationCodeId");
CREATE INDEX IF NOT EXISTS "ba_oauth_access_token_clientId_idx" on "ba_oauth_access_token" ("clientId");
CREATE INDEX IF NOT EXISTS "ba_oauth_access_token_sessionId_idx" on "ba_oauth_access_token" ("sessionId");
CREATE INDEX IF NOT EXISTS "ba_oauth_access_token_userId_idx" on "ba_oauth_access_token" ("userId");
CREATE INDEX IF NOT EXISTS "ba_oauth_access_token_authorizationCodeId_idx" on "ba_oauth_access_token" ("authorizationCodeId");
CREATE INDEX IF NOT EXISTS "ba_oauth_access_token_refreshId_idx" on "ba_oauth_access_token" ("refreshId");
CREATE INDEX IF NOT EXISTS "ba_oauth_consent_clientId_idx" on "ba_oauth_consent" ("clientId");
CREATE INDEX IF NOT EXISTS "ba_oauth_consent_userId_idx" on "ba_oauth_consent" ("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "ba_oauth_client_resource_clientId_resourceId_uidx" on "ba_oauth_client_resource" ("clientId", "resourceId");

-- api: better-auth reads and writes all of them.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ba_jwks, ba_oauth_client, ba_oauth_resource, ba_oauth_client_resource,
     ba_oauth_refresh_token, ba_oauth_access_token, ba_oauth_consent, ba_oauth_client_assertion
  TO openvfr_api;

-- Keys, tokens and consents are auth records: not for PostgREST clients,
-- the pipeline or the tile server.
REVOKE ALL
  ON ba_jwks, ba_oauth_client, ba_oauth_resource, ba_oauth_client_resource,
     ba_oauth_refresh_token, ba_oauth_access_token, ba_oauth_consent, ba_oauth_client_assertion
  FROM openvfr_anon, openvfr_authenticated;

-- migrate:down

DROP TABLE IF EXISTS ba_oauth_client_assertion, ba_oauth_consent, ba_oauth_access_token,
  ba_oauth_refresh_token, ba_oauth_client_resource, ba_oauth_resource, ba_oauth_client, ba_jwks;
