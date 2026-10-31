-- migrate:up

-- ════════════════════════════════════════════════════════════════════════════
-- Minimum native app build per platform (force-update gate).
--
-- GET /api/version reports these numbers; a native app whose own build
-- number (Android versionCode / iOS CFBundleVersion) is lower shows a
-- blocking "Update required" page (apps/native/src/hooks/useForceUpdate.ts).
-- Build numbers, not version names: every store build gets a new build
-- number, while the version name may stay the same across releases.
--
-- Set by an operator from the admin dashboard (POST /api/admin/app-versions).
-- No row for a platform = the api's APP_MIN_BUILD_<PLATFORM> env default
-- (0 = no minimum).
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS app_min_build (
  platform    TEXT         PRIMARY KEY CHECK (platform IN ('android', 'ios')),
  min_build   INTEGER      NOT NULL CHECK (min_build >= 0),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Admin email, for the dashboard ("set by ... at ...").
  updated_by  TEXT
);

-- api: reads it for /api/version, writes it from the admin router.
GRANT SELECT, INSERT, UPDATE ON app_min_build TO api_app;

-- Not for PostgREST clients, the pipeline or the tile server.
REVOKE ALL ON app_min_build FROM anon, authenticated, martin_ro;

-- migrate:down

DROP TABLE IF EXISTS app_min_build;
