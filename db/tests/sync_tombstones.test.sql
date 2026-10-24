-- Checks for migration 20261020000000_sync_tombstones (cloud-sync tombstones,
-- last-write-wins and clock guards, sync_delete RPC, privileges).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/sync_tombstones.test.sql
--
-- Run as the migration owner (superuser) against a migrated database. Every
-- statement runs in ONE transaction that ends in ROLLBACK: nothing is left
-- behind, so it is safe on a restored copy of production data. Requests are
-- made the way PostgREST makes them: SET ROLE authenticator, then
-- SET ROLE authenticated / anon with request.jwt.claims for the user.
-- Any failed check aborts with an error; success prints
-- "sync_tombstones: all checks passed".

\set ON_ERROR_STOP on
BEGIN;

-- ── Fixtures (as owner) ─────────────────────────────────────────────────────
INSERT INTO ba_user (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES
  ('zz-sync-test-1', 't1', 'zz-sync-test-1@example.invalid', true, now(), now()),
  ('zz-sync-test-2', 't2', 'zz-sync-test-2@example.invalid', true, now(), now());

-- Act as PostgREST: authenticator, then the request role + claims.
CREATE TEMP TABLE _ctx (k text PRIMARY KEY, v text);
GRANT ALL ON _ctx TO PUBLIC;
INSERT INTO _ctx VALUES
  ('r1', '00000000-0000-4000-8000-000000000001'),
  ('r2', '00000000-0000-4000-8000-000000000002'),
  ('r3', '00000000-0000-4000-8000-000000000003'),
  ('log', '00000000-0000-4000-8000-000000000004'),
  ('w1', '00000000-0000-4000-8000-000000000005');

SET LOCAL ROLE authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"zz-sync-test-1","role":"authenticated"}', true);

-- ── Last write wins ─────────────────────────────────────────────────────────
DO $$
DECLARE r1 uuid := (SELECT v FROM _ctx WHERE k = 'r1'); ts timestamptz;
BEGIN
  INSERT INTO user_routes (id, user_id, name, updated_at) VALUES (r1, 'zz-sync-test-1', 'v1', now() - interval '1 hour');
  -- newer update applies
  INSERT INTO user_routes (id, user_id, name, updated_at) VALUES (r1, 'zz-sync-test-1', 'v2', now() - interval '30 minutes')
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at;
  ASSERT (SELECT name FROM user_routes WHERE id = r1) = 'v2', 'newer upsert must apply';
  -- older update is skipped, without an error
  INSERT INTO user_routes (id, user_id, name, updated_at) VALUES (r1, 'zz-sync-test-1', 'stale', now() - interval '2 hours')
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at;
  ASSERT (SELECT name FROM user_routes WHERE id = r1) = 'v2', 'older upsert must be skipped';
  UPDATE user_routes SET name = 'stale2', updated_at = now() - interval '3 hours' WHERE id = r1;
  ASSERT (SELECT name FROM user_routes WHERE id = r1) = 'v2', 'older PATCH must be skipped';
  -- equal timestamp passes (idempotent re-upload)
  SELECT updated_at INTO ts FROM user_routes WHERE id = r1;
  UPDATE user_routes SET name = 'v2-same', updated_at = ts WHERE id = r1;
  ASSERT (SELECT name FROM user_routes WHERE id = r1) = 'v2-same', 'equal timestamp must pass';
  RAISE NOTICE 'ok: last write wins';
END $$;

-- ── Clock guard ─────────────────────────────────────────────────────────────
DO $$
DECLARE r2 uuid := (SELECT v FROM _ctx WHERE k = 'r2'); r1 uuid := (SELECT v FROM _ctx WHERE k = 'r1'); ts timestamptz;
BEGIN
  INSERT INTO user_routes (id, user_id, name, updated_at) VALUES (r2, 'zz-sync-test-1', 'future', now() + interval '1 day');
  ASSERT (SELECT updated_at FROM user_routes WHERE id = r2) = now() + interval '2 minutes', 'future insert must be clamped';
  UPDATE user_routes SET updated_at = now() + interval '1 year' WHERE id = r1;
  ASSERT (SELECT updated_at FROM user_routes WHERE id = r1) = now() + interval '2 minutes', 'future update must be clamped';
  -- clamped value is what a return=representation upload reads back
  INSERT INTO user_routes (id, user_id, name, updated_at) VALUES (gen_random_uuid(), 'zz-sync-test-1', 'rep', now() + interval '5 hours')
    RETURNING updated_at INTO ts;
  ASSERT ts = now() + interval '2 minutes', 'RETURNING must show the clamped value';
  RAISE NOTICE 'ok: clock guard';
END $$;
DELETE FROM user_routes WHERE name = 'rep';

-- ── Deletes and tombstones ──────────────────────────────────────────────────
DO $$
DECLARE r3 uuid := (SELECT v FROM _ctx WHERE k = 'r3'); t timestamptz;
BEGIN
  -- sync_delete records the device's delete time (here: behind the server)
  INSERT INTO user_routes (id, user_id, name, updated_at) VALUES (r3, 'zz-sync-test-1', 'x', now() - interval '20 minutes');
  PERFORM sync_delete('user_routes', r3::text, now() - interval '10 minutes');
  ASSERT NOT EXISTS (SELECT 1 FROM user_routes WHERE id = r3), 'sync_delete must delete';
  SELECT deleted_at INTO t FROM user_sync_tombstones WHERE table_name = 'user_routes' AND row_id = r3::text;
  ASSERT t = now() - interval '10 minutes', format('tombstone must carry the device delete time, got %s', t);
  ASSERT current_setting('sync.deleted_at', true) IS NULL OR current_setting('sync.deleted_at', true) = '',
    'sync.deleted_at must not leak past sync_delete';
  -- stale copy (not newer than the delete) is skipped, without an error
  INSERT INTO user_routes (id, user_id, name, updated_at) VALUES (r3, 'zz-sync-test-1', 'zombie', now() - interval '20 minutes')
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at;
  ASSERT NOT EXISTS (SELECT 1 FROM user_routes WHERE id = r3), 'stale re-insert must be skipped';
  -- an edit after the delete (on the same device clock) wins and clears the tombstone
  INSERT INTO user_routes (id, user_id, name, updated_at) VALUES (r3, 'zz-sync-test-1', 'recreated', now() - interval '9 minutes');
  ASSERT (SELECT name FROM user_routes WHERE id = r3) = 'recreated', 'newer re-insert must win';
  ASSERT NOT EXISTS (SELECT 1 FROM user_sync_tombstones WHERE row_id = r3::text), 'tombstone must be cleared';
  -- a tombstone is never older than the row it removed
  UPDATE user_routes SET updated_at = now() - interval '1 minute' WHERE id = r3;
  PERFORM sync_delete('user_routes', r3::text, now() - interval '1 hour');
  ASSERT (SELECT deleted_at FROM user_sync_tombstones WHERE row_id = r3::text) = now() - interval '1 minute',
    'tombstone must be >= the deleted row updated_at';
  -- plain DELETE (older clients) uses server time
  INSERT INTO user_routes (id, user_id, name, updated_at) VALUES (gen_random_uuid(), 'zz-sync-test-1', 'plain', now() - interval '1 day');
  DELETE FROM user_routes WHERE name = 'plain';
  ASSERT (SELECT count(*) FROM user_sync_tombstones WHERE table_name = 'user_routes' AND deleted_at = now()) = 1,
    'plain DELETE must record server time';
  -- future delete time is clamped
  INSERT INTO user_waypoints (id, user_id, name, updated_at) VALUES ((SELECT v FROM _ctx WHERE k = 'w1')::uuid, 'zz-sync-test-1', 'w', now());
  PERFORM sync_delete('user_waypoints', (SELECT v FROM _ctx WHERE k = 'w1'), now() + interval '30 days');
  ASSERT (SELECT deleted_at FROM user_sync_tombstones WHERE table_name = 'user_waypoints') = now() + interval '2 minutes',
    'future delete time must be clamped';
  RAISE NOTICE 'ok: deletes and tombstones';
END $$;

-- ── Settings are addressed by key, per user ─────────────────────────────────
DO $$
BEGIN
  INSERT INTO user_settings (user_id, key, value, updated_at) VALUES ('zz-sync-test-1', 'home', '"ESSB"', now() - interval '10 minutes');
  PERFORM sync_delete('user_settings', 'home', now() - interval '5 minutes');
  ASSERT (SELECT row_id FROM user_sync_tombstones WHERE table_name = 'user_settings') = 'home', 'settings tombstone keyed by key';
  INSERT INTO user_settings (user_id, key, value, updated_at) VALUES ('zz-sync-test-1', 'home', '"stale"', now() - interval '6 minutes')
    ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
  ASSERT NOT EXISTS (SELECT 1 FROM user_settings WHERE key = 'home' AND user_id = 'zz-sync-test-1'), 'stale setting skipped';
  INSERT INTO user_settings (user_id, key, value, updated_at) VALUES ('zz-sync-test-1', 'home', '"ESOW"', now() - interval '4 minutes')
    ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
  ASSERT (SELECT value FROM user_settings WHERE key = 'home' AND user_id = 'zz-sync-test-1') = '"ESOW"', 'newer setting applies';
  RAISE NOTICE 'ok: settings by key';
END $$;

-- ── Flight logs: insert-only, ignore-duplicates, deletable ──────────────────
DO $$
DECLARE lg uuid := (SELECT v FROM _ctx WHERE k = 'log');
BEGIN
  INSERT INTO user_flight_logs (id, user_id, ended_at, updated_at) VALUES (lg, 'zz-sync-test-1', now(), now() - interval '1 hour');
  INSERT INTO user_flight_logs (id, user_id, ended_at, updated_at) VALUES (lg, 'zz-sync-test-1', now(), now())
    ON CONFLICT DO NOTHING;
  ASSERT (SELECT updated_at FROM user_flight_logs WHERE id = lg) = now() - interval '1 hour', 'duplicate log ignored';
  BEGIN
    UPDATE user_flight_logs SET registration = 'X' WHERE id = lg;
    RAISE EXCEPTION 'UPDATE on user_flight_logs must be denied';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM sync_delete('user_flight_logs', lg::text, now());
  ASSERT EXISTS (SELECT 1 FROM user_sync_tombstones WHERE table_name = 'user_flight_logs'), 'log tombstone';
  RAISE NOTICE 'ok: flight logs';
END $$;

-- ── Input validation ────────────────────────────────────────────────────────
DO $$
BEGIN
  BEGIN
    PERFORM sync_delete('ba_user', 'zz-sync-test-1', now());
    RAISE EXCEPTION 'sync_delete must refuse non-sync tables';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM sync_delete('user_routes', 'not-a-uuid', now());
    RAISE EXCEPTION 'sync_delete must reject a malformed id';
  EXCEPTION WHEN invalid_text_representation THEN NULL;
  END;
  BEGIN
    PERFORM sync_delete('user_routes; DROP TABLE user_routes; --', 'x', now());
    RAISE EXCEPTION 'sync_delete must refuse injected table names';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  -- a missing row is not an error
  PERFORM sync_delete('user_routes', gen_random_uuid()::text, now());
  RAISE NOTICE 'ok: input validation';
END $$;

-- ── Isolation between users ─────────────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{"sub":"zz-sync-test-2","role":"authenticated"}', true);
DO $$
DECLARE r1 uuid := (SELECT v FROM _ctx WHERE k = 'r1');
BEGIN
  ASSERT (SELECT count(*) FROM user_sync_tombstones) = 0, 'user 2 must not see user 1 tombstones';
  ASSERT (SELECT count(*) FROM user_routes) = 0, 'user 2 must not see user 1 routes';
  PERFORM sync_delete('user_routes', r1::text, now());
  -- (row invisible to user 2: nothing deleted; checked as owner below)
  BEGIN
    INSERT INTO user_sync_tombstones (user_id, table_name, row_id) VALUES ('zz-sync-test-1', 'user_routes', r1::text);
    RAISE EXCEPTION 'clients must not write tombstones';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM user_sync_tombstones;
    RAISE EXCEPTION 'clients must not delete tombstones';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO user_routes (id, user_id, name, updated_at) VALUES (gen_random_uuid(), 'zz-sync-test-1', 'spoof', now());
    RAISE EXCEPTION 'inserting rows for another user must be denied';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- user 2's own settings key 'home' is independent of user 1's
  INSERT INTO user_settings (user_id, key, value, updated_at) VALUES ('zz-sync-test-2', 'home', '"U2"', now() - interval '1 day');
  ASSERT (SELECT value FROM user_settings WHERE key = 'home') = '"U2"', 'per-user settings keys';
  RAISE NOTICE 'ok: isolation';
END $$;

-- anon: no tombstones, no sync_delete
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM user_sync_tombstones;
    RAISE EXCEPTION 'anon must not read tombstones';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM sync_delete('user_routes', gen_random_uuid()::text, now());
    RAISE EXCEPTION 'anon must not call sync_delete';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: anon denied';
END $$;

-- ── As owner: cross-checks, martin_ro, retention, account deletion ──────────
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE r1 uuid := (SELECT v FROM _ctx WHERE k = 'r1');
BEGIN
  ASSERT EXISTS (SELECT 1 FROM user_routes WHERE id = r1), 'user 2 must not be able to delete user 1 rows';
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'martin_ro') THEN
    ASSERT NOT has_table_privilege('martin_ro', 'user_sync_tombstones', 'SELECT'), 'martin_ro must not read tombstones';
    ASSERT NOT has_function_privilege('martin_ro', 'sync_delete(text,text,timestamptz)', 'EXECUTE'), 'martin_ro must not call sync_delete';
  END IF;
  ASSERT NOT has_function_privilege('anon', 'sync_delete(text,text,timestamptz)', 'EXECUTE'), 'anon must not call sync_delete';
  ASSERT has_function_privilege('authenticated', 'sync_delete(text,text,timestamptz)', 'EXECUTE'), 'authenticated may call sync_delete';
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    ASSERT pg_has_role('authenticator', 'authenticated', 'MEMBER'), 'authenticator must be able to become authenticated';
    ASSERT NOT has_table_privilege('authenticator', 'user_sync_tombstones', 'SELECT'), 'authenticator itself holds nothing';
  END IF;

  -- deletes without JWT claims (API connection, account deletion, admin) leave no tombstone
  DELETE FROM user_settings WHERE user_id = 'zz-sync-test-2';
  ASSERT NOT EXISTS (SELECT 1 FROM user_sync_tombstones WHERE user_id = 'zz-sync-test-2'), 'no tombstone without claims';

  -- retention: tombstones older than 365 days purged on the user's next delete
  INSERT INTO user_sync_tombstones (user_id, table_name, row_id, deleted_at)
    VALUES ('zz-sync-test-1', 'user_routes', 'ancient', now() - interval '400 days');
  RAISE NOTICE 'ok: privileges';
END $$;
SET LOCAL ROLE authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"zz-sync-test-1","role":"authenticated"}', true);
DO $$
BEGIN
  PERFORM sync_delete('user_routes', (SELECT v FROM _ctx WHERE k = 'r1'), now());
  ASSERT NOT EXISTS (SELECT 1 FROM user_sync_tombstones WHERE row_id = 'ancient'), 'old tombstones must be purged';
  RAISE NOTICE 'ok: retention';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);
DO $$
BEGIN
  DELETE FROM ba_user WHERE id IN ('zz-sync-test-1', 'zz-sync-test-2');
  ASSERT NOT EXISTS (SELECT 1 FROM user_sync_tombstones WHERE user_id LIKE 'zz-sync-test-%'), 'account deletion removes tombstones';
  ASSERT NOT EXISTS (SELECT 1 FROM user_routes WHERE user_id LIKE 'zz-sync-test-%'), 'account deletion removes rows';
  RAISE NOTICE 'sync_tombstones: all checks passed';
END $$;

ROLLBACK;
