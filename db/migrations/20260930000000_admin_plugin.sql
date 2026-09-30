-- migrate:up

-- Columns required by better-auth's `admin` plugin (see auth.ts). The api
-- never runs DDL (api_app is CRUD-only), so they are created here. api_app
-- already has table-level CRUD on ba_user / ba_session; martin_ro stays
-- revoked on both.
ALTER TABLE ba_user
  ADD COLUMN IF NOT EXISTS role         TEXT,
  ADD COLUMN IF NOT EXISTS banned       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "banReason"  TEXT,
  ADD COLUMN IF NOT EXISTS "banExpires" TIMESTAMPTZ;

ALTER TABLE ba_session
  ADD COLUMN IF NOT EXISTS "impersonatedBy" TEXT;

-- migrate:down

ALTER TABLE ba_session DROP COLUMN IF EXISTS "impersonatedBy";
ALTER TABLE ba_user
  DROP COLUMN IF EXISTS "banExpires",
  DROP COLUMN IF EXISTS "banReason",
  DROP COLUMN IF EXISTS banned,
  DROP COLUMN IF EXISTS role;
