-- Checks for migration 20261110000000_flight_log_updates (owner may update a
-- flight log; route_json column with its size cap; the existing last-write-wins
-- guard applies to log updates; another user's log stays untouchable).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/flight_log_updates.test.sql
--
-- Run as the migration owner (superuser) against a migrated database. One
-- transaction, rolled back: nothing is left behind. Requests are made the way
-- PostgREST makes them (SET ROLE authenticator -> authenticated + claims).
-- Success prints "flight_log_updates: all checks passed".

\set ON_ERROR_STOP on
BEGIN;

INSERT INTO ba_user (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES
  ('zz-log-test-1', 't1', 'zz-log-test-1@example.invalid', true, now(), now()),
  ('zz-log-test-2', 't2', 'zz-log-test-2@example.invalid', true, now(), now());

SET LOCAL ROLE authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"zz-log-test-1","role":"authenticated"}', true);

DO $$
DECLARE log_id uuid; refused boolean; n int;
BEGIN
  -- A new log as a plain insert that ignores duplicates (what clients send for new logs).
  INSERT INTO user_flight_logs (id, user_id, registration, updated_at)
    VALUES (gen_random_uuid(), 'zz-log-test-1', '', now() - interval '1 hour')
    ON CONFLICT (id) DO NOTHING
    RETURNING id INTO log_id;
  ASSERT log_id IS NOT NULL, 'insert of a new log must pass';

  -- Owner sets the aircraft and the planned route (an upsert, as clients send edits).
  INSERT INTO user_flight_logs (id, user_id, aircraft_id, registration, route_json, updated_at)
    VALUES (log_id, 'zz-log-test-1', 'ac-1', 'SE-ABC', '{"waypoints":[]}', now() - interval '30 minutes')
    ON CONFLICT (id) DO UPDATE SET aircraft_id = EXCLUDED.aircraft_id, registration = EXCLUDED.registration,
      route_json = EXCLUDED.route_json, updated_at = EXCLUDED.updated_at;
  ASSERT (SELECT registration FROM user_flight_logs WHERE id = log_id) = 'SE-ABC', 'owner update must apply';
  ASSERT (SELECT route_json FROM user_flight_logs WHERE id = log_id) = '{"waypoints":[]}', 'route_json stored';

  -- An older copy does not overwrite a newer one (sync_guard_update).
  UPDATE user_flight_logs SET registration = 'SE-OLD', updated_at = now() - interval '2 hours' WHERE id = log_id;
  ASSERT (SELECT registration FROM user_flight_logs WHERE id = log_id) = 'SE-ABC', 'older update must be skipped';

  -- route_json size cap: 1 MiB passes, more is refused.
  UPDATE user_flight_logs SET route_json = repeat('r', 1048576), updated_at = now() WHERE id = log_id;
  refused := false;
  BEGIN
    UPDATE user_flight_logs SET route_json = repeat('r', 1048577), updated_at = now() + interval '1 second' WHERE id = log_id;
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  ASSERT refused, 'route_json over 1 MiB must be refused';

  -- Not to another user.
  refused := false;
  BEGIN
    UPDATE user_flight_logs SET user_id = 'zz-log-test-2', updated_at = now() + interval '1 minute' WHERE id = log_id;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN refused := true;
  END;
  ASSERT refused OR (SELECT user_id FROM user_flight_logs WHERE id = log_id) = 'zz-log-test-1',
    'a log must not be moved to another user';
  RAISE NOTICE 'ok: owner updates, last write wins, size cap';
END $$;

-- Another user cannot see or change it.
SELECT set_config('request.jwt.claims', '{"sub":"zz-log-test-2","role":"authenticated"}', true);
DO $$
DECLARE n int;
BEGIN
  UPDATE user_flight_logs SET registration = 'SE-HACK', updated_at = now() + interval '1 minute';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'another user must update no rows';
  ASSERT (SELECT count(*) FROM user_flight_logs) = 0, 'another user sees no rows';
  RAISE NOTICE 'ok: other users cannot touch the log';
END $$;

\echo 'flight_log_updates: all checks passed'
ROLLBACK;
