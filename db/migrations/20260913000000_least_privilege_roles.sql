-- migrate:up

-- ════════════════════════════════════════════════════════════════════════════
-- Least-privilege connection roles.
--
-- Previously every service (api, postgrest, martin, cron) connected as the
-- `openvfr` role -- which the official postgres image creates as a SUPERUSER.
-- That meant:
--   * PostgREST's `SET ROLE <jwt role claim>` ran from a superuser, so any
--     forged/leaked JWT naming any role at all (incl. `openvfr` itself)
--     got full, RLS-bypassing database access.
--   * Martin (read-only tile server) and the Hono api (only touches ba_*
--     tables) both held superuser credentials for no reason.
--
-- This migration creates one LOGIN role per service, each with only what
-- that service actually needs. Passwords are NOT set here -- SQL migrations
-- can't read the environment and must stay committable. The deploy
-- tooling (infra repo, `scripts/sync-db-role-passwords.sh`) runs
-- `ALTER ROLE ... PASSWORD` from .env.prod after every migration run.
-- Until that runs, these roles exist but cannot log in (no password).
--
-- `openvfr` (superuser) remains for migrations, backups, and manual
-- maintenance only. No long-running service should use it anymore.
-- ════════════════════════════════════════════════════════════════════════════

-- ── authenticator: PostgREST's connection role ──────────────────────────────
-- NOINHERIT: holds no privileges of its own; PostgREST issues SET ROLE
-- anon / authenticated per request, and that is the ONLY thing it can
-- switch to. Any other `role` claim in a JWT fails the SET ROLE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT;
  END IF;
END $$;
GRANT anon          TO authenticator;
GRANT authenticated TO authenticator;

-- openvfr no longer needs to impersonate the request roles (it's superuser
-- anyway, so this GRANT was only ever meaningful for PostgREST).
REVOKE anon          FROM openvfr;
REVOKE authenticated FROM openvfr;

-- ── martin_ro: tile server, read-only ───────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'martin_ro') THEN
    CREATE ROLE martin_ro LOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO martin_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO martin_ro;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO martin_ro;
-- Future tables/functions created by openvfr (migrations) stay readable.
ALTER DEFAULT PRIVILEGES FOR ROLE openvfr IN SCHEMA public
  GRANT SELECT ON TABLES TO martin_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE openvfr IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO martin_ro;

-- Martin must never see user data even though it's SELECT-only: user_*
-- tables are RLS-protected and martin_ro has no request.jwt.claims, so
-- auth_user_id() is NULL and every policy evaluates false -- but the ba_*
-- auth tables have no RLS at all. Revoke those explicitly.
REVOKE ALL ON ba_user, ba_session, ba_account, ba_verification, ba_passkey
  FROM martin_ro;

-- ── api_app: Hono API / better-auth ─────────────────────────────────────────
-- better-auth's Kysely adapter only touches the ba_* tables (pre-created by
-- the initial migration; better-auth never DDLs at runtime here). User data
-- tables are reached exclusively through PostgREST, so api_app gets nothing
-- on them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'api_app') THEN
    CREATE ROLE api_app LOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO api_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ba_user, ba_session, ba_account, ba_verification, ba_passkey
  TO api_app;

-- ── cron_app: scheduled data-refresh jobs ───────────────────────────────────
-- cron_*.py only touch data_loads (record_static_load.py). No spatial
-- tables exist in Postgres anymore.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cron_app') THEN
    CREATE ROLE cron_app LOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO cron_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON data_loads TO cron_app;
GRANT USAGE, SELECT ON SEQUENCE data_loads_id_seq TO cron_app;

-- migrate:down

REVOKE ALL ON data_loads FROM cron_app;
REVOKE ALL ON SEQUENCE data_loads_id_seq FROM cron_app;
REVOKE USAGE ON SCHEMA public FROM cron_app;
DROP ROLE IF EXISTS cron_app;

REVOKE ALL ON ba_user, ba_session, ba_account, ba_verification, ba_passkey FROM api_app;
REVOKE USAGE ON SCHEMA public FROM api_app;
DROP ROLE IF EXISTS api_app;

ALTER DEFAULT PRIVILEGES FOR ROLE openvfr IN SCHEMA public
  REVOKE SELECT ON TABLES FROM martin_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE openvfr IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM martin_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM martin_ro;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM martin_ro;
REVOKE USAGE ON SCHEMA public FROM martin_ro;
DROP ROLE IF EXISTS martin_ro;

GRANT anon          TO openvfr;
GRANT authenticated TO openvfr;
REVOKE anon          FROM authenticator;
REVOKE authenticated FROM authenticator;
DROP ROLE IF EXISTS authenticator;
