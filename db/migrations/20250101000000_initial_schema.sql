-- migrate:up

-- Full current schema, applied via dbmate (`scripts/migrate.sh up`).
-- Replaces the old docker/init.sql (docker-entrypoint-initdb.d), which only
-- ran once on an empty Postgres data volume and could never patch a live
-- database. dbmate tracks applied migrations in schema_migrations and can
-- run repeatedly, on fresh or existing databases.
--
-- Idempotent throughout (CREATE ... IF NOT EXISTS / CREATE OR REPLACE
-- FUNCTION / guarded DO blocks), same guarantee the old init.sql had. Future
-- schema changes go in new numbered migration files, not edits here.

-- docker/init.sql
-- Executed once when the PostGIS container is first created.
-- Run: docker compose up  (the db service mounts this at initdb.d/)

CREATE EXTENSION IF NOT EXISTS postgis;

-- ════════════════════════════════════════════════════════════════════════════
-- NOTE: OSM landuse polygons (farmland, residential, commercial, industrial)
-- used to have a landuse PostGIS table + landuse_tiles() Martin MVT function
-- here. Retired -- raw GeoJSON (scripts/osm_landuse_to_geojson.py, unchanged)
-- is now tiled with tippecanoe into a static per-country se-landuse.pmtiles
-- file served from object storage instead -- too large (~390 MB raw) for a
-- plain client-side geojson source like the other retired layers, hence the
-- PMTiles step. See docs/self-hosting.md. No prod deployment ever depended on this schema, so it was
-- removed directly from this single initial migration rather than kept as a
-- separate retirement migration on top of a table only ever created and
-- immediately dropped again (same rationale as the aeroway_lines / OFMX
-- group / obstacles retirements noted below).
-- ════════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════════
-- NOTE: OSM aeroway lines (taxiways, aprons, OSM-mapped runways) used to have
-- an aeroway_lines PostGIS table + aeroway_tiles() Martin MVT function here.
-- Retired -- served as a static per-country GeoJSON file from object
-- storage instead. See docs/self-hosting.md.
-- No prod deployment ever depended on this schema, so it was removed
-- directly from this single initial migration rather than kept as a
-- separate retirement migration on top of a table only ever created and
-- immediately dropped again (same rationale as the OFMX group / obstacles
-- retirement noted below).
-- ════════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════════
-- NOTE: the OFM aviation group (airspace, aerodromes, navaids, waypoints,
-- runways, runway_thresholds) and obstacles both used to have PostGIS
-- tables + Martin MVT functions here. Both are fully retired -- served as
-- static per-country GeoJSON files from object storage instead. See
-- docs/self-hosting.md. No prod deployment ever
-- depended on this schema, so both were removed directly from this single
-- initial migration rather than kept as separate retirement migrations on
-- top of tables that were only ever created and immediately dropped again.
-- ════════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════════
-- Data load metadata
-- Upserted by scripts/db_atomic_load.py after every successful commit.
-- Used by the AIRAC auto-update cron to determine whether a country's data
-- is current without scanning the actual data tables.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS data_loads (
  id          BIGSERIAL    PRIMARY KEY,
  -- Logical dataset label: the table name by default
  -- (e.g. 'airspace', 'aerodromes', 'obstacles', 'landuse', 'aeroway_lines').
  dataset     VARCHAR(30)  NOT NULL,
  -- ISO 3166-1 alpha-2, lower-case.
  country     CHAR(2)      NOT NULL,
  -- AIRAC cycle in YYNN format (e.g. '2604').  NULL for non-AIRAC datasets
  -- (obstacles, landuse, aeroway_lines) which refresh on a calendar schedule.
  airac_cycle VARCHAR(4),
  -- UTC timestamp of the last successful commit for this (dataset, country).
  loaded_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Row count recorded inside the same transaction as the data load — precise.
  row_count   INTEGER      NOT NULL DEFAULT 0,
  CONSTRAINT data_loads_dataset_country UNIQUE (dataset, country)
);

-- ════════════════════════════════════════════════════════════════════════════
-- PostgreSQL roles for PostgREST
-- `anon`          — unauthenticated requests; read-only access to aviation data
-- `authenticated` — JWT-verified requests; full CRUD on own user data
-- Guards use DO blocks so re-running init.sql never fails on existing roles.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;

-- Allow PostgREST to switch into these roles (it connects as openvfr).
GRANT anon        TO openvfr;
GRANT authenticated TO openvfr;

-- ════════════════════════════════════════════════════════════════════════════
-- better-auth tables  (prefix: ba_)
-- Schema matches better-auth v1 core + passkey + magicLink plugins.
-- Prefix avoids collisions with existing aviation tables.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ba_user (
  id              TEXT         PRIMARY KEY,
  name            TEXT         NOT NULL DEFAULT '',
  email           TEXT         NOT NULL,
  "emailVerified" BOOLEAN      NOT NULL DEFAULT FALSE,
  image           TEXT,
  "createdAt"     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ba_user_email_uniq UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS ba_session (
  id           TEXT         PRIMARY KEY,
  "expiresAt"  TIMESTAMPTZ  NOT NULL,
  token        TEXT         NOT NULL,
  "userId"     TEXT         NOT NULL REFERENCES ba_user (id) ON DELETE CASCADE,
  "ipAddress"  TEXT,
  "userAgent"  TEXT,
  "createdAt"  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updatedAt"  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ba_session_token_uniq UNIQUE (token)
);
CREATE INDEX IF NOT EXISTS ba_session_user_id_idx ON ba_session ("userId");

CREATE TABLE IF NOT EXISTS ba_account (
  id                     TEXT         PRIMARY KEY,
  "accountId"            TEXT         NOT NULL,
  "providerId"           TEXT         NOT NULL,
  "userId"               TEXT         NOT NULL REFERENCES ba_user (id) ON DELETE CASCADE,
  "accessToken"          TEXT,
  "refreshToken"         TEXT,
  "idToken"              TEXT,
  "accessTokenExpiresAt"  TIMESTAMPTZ,
  "refreshTokenExpiresAt" TIMESTAMPTZ,
  scope                  TEXT,
  password               TEXT,
  "createdAt"            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updatedAt"            TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ba_account_user_id_idx ON ba_account ("userId");

CREATE TABLE IF NOT EXISTS ba_verification (
  id           TEXT         PRIMARY KEY,
  identifier   TEXT         NOT NULL,
  value        TEXT         NOT NULL,
  "expiresAt"  TIMESTAMPTZ  NOT NULL,
  "createdAt"  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updatedAt"  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ba_verification_identifier_idx ON ba_verification (identifier);

CREATE TABLE IF NOT EXISTS ba_passkey (
  id             TEXT         PRIMARY KEY,
  name           TEXT,
  "publicKey"    TEXT         NOT NULL,
  "userId"       TEXT         NOT NULL REFERENCES ba_user (id) ON DELETE CASCADE,
  "credentialID" TEXT         NOT NULL,
  counter        BIGINT       NOT NULL DEFAULT 0,
  "deviceType"   TEXT,
  "backedUp"     BOOLEAN      NOT NULL DEFAULT FALSE,
  transports     TEXT,
  aaguid         TEXT,
  "createdAt"    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ba_passkey_credential_id_uniq UNIQUE ("credentialID")
);
CREATE INDEX IF NOT EXISTS ba_passkey_user_id_idx ON ba_passkey ("userId");

-- ════════════════════════════════════════════════════════════════════════════
-- User data tables  (per-user, RLS protected)
-- All tables share the pattern:
--   id UUID PK, user_id UUID FK→ba_user, updated_at TIMESTAMPTZ
-- PostgREST last-write-wins sync uses updated_at for conflict resolution.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS user_routes (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT         NOT NULL REFERENCES ba_user (id) ON DELETE CASCADE,
  name         TEXT         NOT NULL DEFAULT '',
  waypoints    JSONB        NOT NULL DEFAULT '[]',
  leg_overrides JSONB       NOT NULL DEFAULT '{}',
  aircraft_id  TEXT         NOT NULL DEFAULT '',
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
ALTER TABLE user_routes ADD COLUMN IF NOT EXISTS aircraft_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS user_routes_user_id_idx ON user_routes (user_id);

CREATE TABLE IF NOT EXISTS user_aircraft_profiles (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT         NOT NULL REFERENCES ba_user (id) ON DELETE CASCADE,
  data         JSONB        NOT NULL DEFAULT '{}',
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_aircraft_profiles_user_id_idx ON user_aircraft_profiles (user_id);

CREATE TABLE IF NOT EXISTS user_waypoints (
  id           UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT             NOT NULL REFERENCES ba_user (id) ON DELETE CASCADE,
  name         TEXT             NOT NULL DEFAULT '',
  lng          DOUBLE PRECISION NOT NULL DEFAULT 0,
  lat          DOUBLE PRECISION NOT NULL DEFAULT 0,
  folder       TEXT             NOT NULL DEFAULT '',
  updated_at   TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_waypoints_user_id_idx ON user_waypoints (user_id);

CREATE TABLE IF NOT EXISTS user_settings (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT         NOT NULL REFERENCES ba_user (id) ON DELETE CASCADE,
  key          TEXT         NOT NULL,
  value        TEXT         NOT NULL DEFAULT '',
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT user_settings_user_key_uniq UNIQUE (user_id, key)
);
CREATE INDEX IF NOT EXISTS user_settings_user_id_idx ON user_settings (user_id);

-- flight_logs is append-only: INSERT + SELECT only, no UPDATE / DELETE.
-- The recording device is the sole writer; any device can read.
CREATE TABLE IF NOT EXISTS user_flight_logs (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        TEXT         NOT NULL REFERENCES ba_user (id) ON DELETE CASCADE,
  started_at     TIMESTAMPTZ,
  ended_at       TIMESTAMPTZ,
  aircraft_id    TEXT         NOT NULL DEFAULT '',
  registration   TEXT         NOT NULL DEFAULT '',
  track_json     TEXT         NOT NULL DEFAULT '[]',
  departure_icao TEXT         NOT NULL DEFAULT '',
  arrival_icao   TEXT         NOT NULL DEFAULT '',
  distance_nm    REAL,
  max_alt_ft     INTEGER,
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_flight_logs_user_id_idx ON user_flight_logs (user_id);

-- ════════════════════════════════════════════════════════════════════════════
-- Row-Level Security
-- All user tables are locked to their owner via the JWT sub claim injected
-- by PostgREST as request.jwt.claims.  The `authenticated` role can only
-- see / modify its own rows.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE user_routes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_aircraft_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_waypoints        ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_flight_logs      ENABLE ROW LEVEL SECURITY;

-- Helper: extract the caller's user_id from the PostgREST JWT sub claim.
-- Returns NULL (no match) when called outside a PostgREST request context.
CREATE OR REPLACE FUNCTION auth_user_id() RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT current_setting('request.jwt.claims', true)::json->>'sub'
$$;

-- CREATE POLICY has no IF NOT EXISTS clause in Postgres — DROP+CREATE keeps
-- this idempotent for databases that already had these policies (e.g. from
-- the old docker/init.sql this migration replaces).
DROP POLICY IF EXISTS user_routes_own ON user_routes;
CREATE POLICY user_routes_own ON user_routes
  USING  (auth_user_id() = user_id)
  WITH CHECK (auth_user_id() = user_id);

DROP POLICY IF EXISTS user_aircraft_profiles_own ON user_aircraft_profiles;
CREATE POLICY user_aircraft_profiles_own ON user_aircraft_profiles
  USING  (auth_user_id() = user_id)
  WITH CHECK (auth_user_id() = user_id);

DROP POLICY IF EXISTS user_waypoints_own ON user_waypoints;
CREATE POLICY user_waypoints_own ON user_waypoints
  USING  (auth_user_id() = user_id)
  WITH CHECK (auth_user_id() = user_id);

DROP POLICY IF EXISTS user_settings_own ON user_settings;
CREATE POLICY user_settings_own ON user_settings
  USING  (auth_user_id() = user_id)
  WITH CHECK (auth_user_id() = user_id);

-- flight_logs: read own records, insert own records, delete own records.
-- Still no UPDATE -- a completed log is never edited after the fact, only
-- removed (see native/web Flight Logs UI delete action).
DROP POLICY IF EXISTS user_flight_logs_select ON user_flight_logs;
CREATE POLICY user_flight_logs_select ON user_flight_logs
  FOR SELECT USING (auth_user_id() = user_id);

DROP POLICY IF EXISTS user_flight_logs_insert ON user_flight_logs;
CREATE POLICY user_flight_logs_insert ON user_flight_logs
  FOR INSERT WITH CHECK (auth_user_id() = user_id);

DROP POLICY IF EXISTS user_flight_logs_delete ON user_flight_logs;
CREATE POLICY user_flight_logs_delete ON user_flight_logs
  FOR DELETE USING (auth_user_id() = user_id);

-- ════════════════════════════════════════════════════════════════════════════
-- GRANT privileges
-- anon: read-only access to aviation/reference data only (no user tables)
-- authenticated: full CRUD on own user tables (flight_logs: INSERT+SELECT+DELETE, no UPDATE)
-- ════════════════════════════════════════════════════════════════════════════

GRANT USAGE ON SCHEMA public TO anon, authenticated;

-- Aviation reference data — readable by everyone (incl. unauthenticated map loads)
-- landuse and aeroway_lines both retired (see NOTE comments above) -- only
-- data_loads remains a live table here.
GRANT SELECT ON data_loads
  TO anon, authenticated;

-- User data — authenticated users only
GRANT SELECT, INSERT, UPDATE, DELETE
  ON user_routes, user_aircraft_profiles, user_waypoints, user_settings
  TO authenticated;

GRANT SELECT, INSERT, DELETE ON user_flight_logs TO authenticated;

-- migrate:down

DROP POLICY IF EXISTS user_flight_logs_delete ON user_flight_logs;
DROP POLICY IF EXISTS user_flight_logs_insert ON user_flight_logs;
DROP POLICY IF EXISTS user_flight_logs_select ON user_flight_logs;
DROP POLICY IF EXISTS user_settings_own ON user_settings;
DROP POLICY IF EXISTS user_waypoints_own ON user_waypoints;
DROP POLICY IF EXISTS user_aircraft_profiles_own ON user_aircraft_profiles;
DROP POLICY IF EXISTS user_routes_own ON user_routes;
DROP FUNCTION IF EXISTS auth_user_id();

DROP TABLE IF EXISTS user_flight_logs;
DROP TABLE IF EXISTS user_settings;
DROP TABLE IF EXISTS user_waypoints;
DROP TABLE IF EXISTS user_aircraft_profiles;
DROP TABLE IF EXISTS user_routes;

DROP TABLE IF EXISTS ba_passkey;
DROP TABLE IF EXISTS ba_verification;
DROP TABLE IF EXISTS ba_account;
DROP TABLE IF EXISTS ba_session;
DROP TABLE IF EXISTS ba_user;

-- DROP OWNED BY revokes every privilege granted TO these roles (e.g. the
-- GRANT USAGE ON SCHEMA public TO anon, authenticated above, which survives
-- the table DROPs since the schema itself isn't dropped) -- without this,
-- DROP ROLE fails with "role ... cannot be dropped because some objects
-- depend on it" (2BP01).
DROP OWNED BY anon;
DROP OWNED BY authenticated;

REVOKE anon FROM openvfr;
REVOKE authenticated FROM openvfr;
DROP ROLE IF EXISTS anon;
DROP ROLE IF EXISTS authenticated;

DROP TABLE IF EXISTS data_loads;


DROP FUNCTION IF EXISTS aeroway_tiles(integer, integer, integer, json);
DROP TABLE IF EXISTS aeroway_lines;

DROP FUNCTION IF EXISTS landuse_tiles(integer, integer, integer, json);
DROP TABLE IF EXISTS landuse;
