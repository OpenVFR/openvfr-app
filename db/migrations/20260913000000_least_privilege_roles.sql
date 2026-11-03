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

-- ── openvfr_authenticator: PostgREST's connection role ──────────────────────────────
-- NOINHERIT: holds no privileges of its own; PostgREST issues SET ROLE
-- openvfr_anon / openvfr_authenticated per request, and that is the ONLY thing it can
-- switch to. Any other `role` claim in a JWT fails the SET ROLE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'openvfr_authenticator') THEN
    CREATE ROLE openvfr_authenticator LOGIN NOINHERIT;
  END IF;
END $$;
GRANT openvfr_anon          TO openvfr_authenticator;
GRANT openvfr_authenticated TO openvfr_authenticator;

-- openvfr no longer needs to impersonate the request roles (it's superuser
-- anyway, so this GRANT was only ever meaningful for PostgREST).
REVOKE openvfr_anon          FROM openvfr;
REVOKE openvfr_authenticated FROM openvfr;

-- ── openvfr_martin: tile server, read-only ───────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'openvfr_martin') THEN
    CREATE ROLE openvfr_martin LOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO openvfr_martin;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO openvfr_martin;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO openvfr_martin;
-- Future tables/functions created by openvfr (migrations) stay readable.
ALTER DEFAULT PRIVILEGES FOR ROLE openvfr IN SCHEMA public
  GRANT SELECT ON TABLES TO openvfr_martin;
ALTER DEFAULT PRIVILEGES FOR ROLE openvfr IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO openvfr_martin;

-- Martin must never see user data even though it's SELECT-only: user_*
-- tables are RLS-protected and openvfr_martin has no request.jwt.claims, so
-- auth_user_id() is NULL and every policy evaluates false -- but the ba_*
-- auth tables have no RLS at all. Revoke those explicitly.
REVOKE ALL ON ba_user, ba_session, ba_account, ba_verification, ba_passkey
  FROM openvfr_martin;

-- ── openvfr_api: Hono API / better-auth ─────────────────────────────────────────
-- better-auth's Kysely adapter only touches the ba_* tables (pre-created by
-- the initial migration; better-auth never DDLs at runtime here). User data
-- tables are reached exclusively through PostgREST, so openvfr_api gets nothing
-- on them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'openvfr_api') THEN
    CREATE ROLE openvfr_api LOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO openvfr_api;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ba_user, ba_session, ba_account, ba_verification, ba_passkey
  TO openvfr_api;

-- ── openvfr_cron: scheduled data-refresh jobs ───────────────────────────────────
-- cron_*.py only touch data_loads (record_static_load.py). No spatial
-- tables exist in Postgres anymore.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'openvfr_cron') THEN
    CREATE ROLE openvfr_cron LOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO openvfr_cron;
GRANT SELECT, INSERT, UPDATE, DELETE ON data_loads TO openvfr_cron;
GRANT USAGE, SELECT ON SEQUENCE data_loads_id_seq TO openvfr_cron;

-- migrate:down

REVOKE ALL ON data_loads FROM openvfr_cron;
REVOKE ALL ON SEQUENCE data_loads_id_seq FROM openvfr_cron;
REVOKE USAGE ON SCHEMA public FROM openvfr_cron;
DROP ROLE IF EXISTS openvfr_cron;

REVOKE ALL ON ba_user, ba_session, ba_account, ba_verification, ba_passkey FROM openvfr_api;
REVOKE USAGE ON SCHEMA public FROM openvfr_api;
DROP ROLE IF EXISTS openvfr_api;

ALTER DEFAULT PRIVILEGES FOR ROLE openvfr IN SCHEMA public
  REVOKE SELECT ON TABLES FROM openvfr_martin;
ALTER DEFAULT PRIVILEGES FOR ROLE openvfr IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM openvfr_martin;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM openvfr_martin;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM openvfr_martin;
REVOKE USAGE ON SCHEMA public FROM openvfr_martin;
DROP ROLE IF EXISTS openvfr_martin;

GRANT openvfr_anon          TO openvfr;
GRANT openvfr_authenticated TO openvfr;
REVOKE openvfr_anon          FROM openvfr_authenticator;
REVOKE openvfr_authenticated FROM openvfr_authenticator;
DROP ROLE IF EXISTS openvfr_authenticator;
