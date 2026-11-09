-- migrate:up

-- Which client created the session ('native' = the mobile app, NULL = web).
-- Set at sign-in by the databaseHooks in apps/api/src/auth.ts, which gives
-- native sessions a longer lifetime. Read there on later requests, so a
-- session's lifetime follows how it was created, not the current request.
ALTER TABLE ba_session ADD COLUMN IF NOT EXISTS client TEXT;

-- migrate:down

ALTER TABLE ba_session DROP COLUMN IF EXISTS client;
