-- migrate:up

-- ════════════════════════════════════════════════════════════════════════════
-- Country registry: which countries this deployment serves.
--
-- One row per country (ISO 3166-1 alpha-2, lower-case, same codes as
-- packages/shared/src/regions.ts). Everything that is per-country reads
-- this table instead of its own hardcoded list or env var:
--   * the api's GET /api/countries, which web/native use to build the
--     country picker in Settings;
--   * the data pipeline's cron jobs, which build and refresh each enabled
--     country's tiles/GeoJSON.
--
-- Lifecycle:
--   1. An operator sets enabled = true (enabled_at = now()).
--   2. The pipeline notices an enabled country with tiles_ready_at IS NULL,
--      builds and uploads all of its data, then sets tiles_ready_at (or
--      last_error on failure).
--   3. Only from then on does /api/countries list it, so a client never
--      offers a country whose files don't exist yet.
-- Disabling (enabled = false) removes it from /api/countries at once; the
-- data itself is left in place.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS countries (
  code            CHAR(2)      PRIMARY KEY CHECK (code ~ '^[a-z]{2}$'),
  enabled         BOOLEAN      NOT NULL DEFAULT FALSE,
  enabled_at      TIMESTAMPTZ,
  -- Set by the pipeline once every dataset for this country is built and
  -- uploaded. NULL = not (yet) available to clients.
  tiles_ready_at  TIMESTAMPTZ,
  -- Last pipeline failure for this country, for the operator UI. Cleared
  -- on the next success.
  last_error      TEXT,
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Sweden is the only country with a complete pipeline today.
INSERT INTO countries (code, enabled, enabled_at, tiles_ready_at)
VALUES ('se', TRUE, now(), now())
ON CONFLICT (code) DO NOTHING;

-- api: reads the registry (/api/countries); the admin router
-- (PUT /api/admin/countries/:code) enables/disables. It cannot mark data
-- ready -- only the pipeline knows that.
GRANT SELECT ON countries TO api_app;
GRANT INSERT (code, enabled, enabled_at, updated_at) ON countries TO api_app;
GRANT UPDATE (enabled, enabled_at, updated_at) ON countries TO api_app;

-- cron: reads the registry, reports readiness/errors. Cannot enable or
-- disable a country.
GRANT SELECT ON countries TO cron_app;
GRANT UPDATE (tiles_ready_at, last_error, updated_at) ON countries TO cron_app;

-- Not for PostgREST clients or the tile server.
REVOKE ALL ON countries FROM anon, authenticated, martin_ro;

-- migrate:down

DROP TABLE IF EXISTS countries;
