-- Checks for migration 20261101000000_user_data_limits (per-user size caps,
-- row-count quotas, auth_user_id() with empty claims, martin_ro revokes).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/user_data_limits.test.sql
--
-- Run as the migration owner (superuser) against a migrated database. One
-- transaction, rolled back: nothing is left behind. Requests are made the
-- way PostgREST makes them (SET ROLE authenticator -> authenticated + claims).
-- Success prints "user_data_limits: all checks passed".

\set ON_ERROR_STOP on
BEGIN;

INSERT INTO ba_user (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES
  ('zz-limit-test-1', 't1', 'zz-limit-test-1@example.invalid', true, now(), now()),
  ('zz-limit-test-2', 't2', 'zz-limit-test-2@example.invalid', true, now(), now());

-- ── Privileges (as owner) ───────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'martin_ro') THEN
    FOREACH t IN ARRAY ARRAY['user_routes', 'user_aircraft_profiles', 'user_waypoints', 'user_settings', 'user_flight_logs', 'user_sync_tombstones']
    LOOP
      ASSERT NOT has_table_privilege('martin_ro', t, 'SELECT'), format('martin_ro must not read %s', t);
    END LOOP;
  END IF;
  RAISE NOTICE 'ok: martin_ro has no access to user tables';
END $$;

SET LOCAL ROLE authenticator;
SET LOCAL ROLE authenticated;

-- ── auth_user_id() with an empty claims setting ─────────────────────────────
SELECT set_config('request.jwt.claims', '', true);
DO $$
BEGIN
  ASSERT auth_user_id() IS NULL, 'empty claims must give NULL, not an error';
  ASSERT (SELECT count(*) FROM user_routes) = 0, 'no claims: no rows visible';
  RAISE NOTICE 'ok: auth_user_id() tolerates empty claims';
END $$;

SELECT set_config('request.jwt.claims', '{"sub":"zz-limit-test-1","role":"authenticated"}', true);

-- ── Size caps ───────────────────────────────────────────────────────────────
DO $$
DECLARE refused boolean;
BEGIN
  -- At the cap passes.
  INSERT INTO user_routes (user_id, name) VALUES ('zz-limit-test-1', repeat('n', 1000));
  INSERT INTO user_flight_logs (user_id, track_json) VALUES ('zz-limit-test-1', repeat('x', 16777216));

  refused := false;
  BEGIN
    INSERT INTO user_routes (user_id, name) VALUES ('zz-limit-test-1', repeat('n', 1001));
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  ASSERT refused, 'route name over 1000 bytes must be refused';

  refused := false;
  BEGIN
    INSERT INTO user_flight_logs (user_id, track_json) VALUES ('zz-limit-test-1', repeat('x', 16777217));
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  ASSERT refused, 'track_json over 16 MiB must be refused';

  refused := false;
  BEGIN
    INSERT INTO user_aircraft_profiles (user_id, data)
      VALUES ('zz-limit-test-1', jsonb_build_object('notes', repeat('d', 262144)));
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  ASSERT refused, 'aircraft profile over 256 KiB must be refused';

  refused := false;
  BEGIN
    UPDATE user_routes SET name = repeat('n', 2000), updated_at = now() WHERE user_id = 'zz-limit-test-1';
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  ASSERT refused, 'an update must not exceed the cap either';
  RAISE NOTICE 'ok: size caps';
END $$;
DELETE FROM user_routes WHERE user_id = 'zz-limit-test-1';
DELETE FROM user_flight_logs WHERE user_id = 'zz-limit-test-1';

-- ── Row-count quota (aircraft: 500) ─────────────────────────────────────────
DO $$
DECLARE refused boolean; first_id uuid; n int;
BEGIN
  INSERT INTO user_aircraft_profiles (user_id, updated_at)
    SELECT 'zz-limit-test-1', now() - interval '1 hour' FROM generate_series(1, 500);
  ASSERT (SELECT count(*) FROM user_aircraft_profiles) = 500, 'setup: 500 rows';

  refused := false;
  BEGIN
    INSERT INTO user_aircraft_profiles (user_id) VALUES ('zz-limit-test-1');
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  ASSERT refused, 'the 501st row must be refused';

  -- Upsert of an existing row at the cap is an edit and passes.
  SELECT id INTO first_id FROM user_aircraft_profiles ORDER BY id LIMIT 1;
  INSERT INTO user_aircraft_profiles (id, user_id, data, updated_at)
    VALUES (first_id, 'zz-limit-test-1', '{"name":"edited"}', now())
    ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at;
  ASSERT (SELECT data->>'name' FROM user_aircraft_profiles WHERE id = first_id) = 'edited', 'upsert at the cap must apply';

  -- A stale copy of a deleted row is dropped by sync_guard_insert before the
  -- quota counts it; a real new row then fits again.
  PERFORM sync_delete('user_aircraft_profiles', first_id::text, now());
  INSERT INTO user_aircraft_profiles (id, user_id, updated_at)
    VALUES (first_id, 'zz-limit-test-1', now() - interval '2 hours');
  ASSERT NOT EXISTS (SELECT 1 FROM user_aircraft_profiles WHERE id = first_id), 'stale re-insert must be skipped';
  INSERT INTO user_aircraft_profiles (user_id) VALUES ('zz-limit-test-1');
  SELECT count(*) INTO n FROM user_aircraft_profiles;
  ASSERT n = 500, format('back at the cap after delete + new row, got %s', n);
  RAISE NOTICE 'ok: row-count quota';
END $$;

-- Another user's quota is independent.
SELECT set_config('request.jwt.claims', '{"sub":"zz-limit-test-2","role":"authenticated"}', true);
DO $$
BEGIN
  INSERT INTO user_aircraft_profiles (user_id) VALUES ('zz-limit-test-2');
  ASSERT (SELECT count(*) FROM user_aircraft_profiles) = 1, 'user 2 sees only its own row';
  RAISE NOTICE 'ok: quotas are per user';
END $$;

-- Settings use (user_id, key) as identity.
DO $$
DECLARE refused boolean;
BEGIN
  INSERT INTO user_settings (user_id, key, value)
    SELECT 'zz-limit-test-2', 'k' || g, 'v' FROM generate_series(1, 1000) g;
  INSERT INTO user_settings (user_id, key, value, updated_at) VALUES ('zz-limit-test-2', 'k1', 'v2', now() + interval '1 minute')
    ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
  ASSERT (SELECT value FROM user_settings WHERE key = 'k1') = 'v2', 'settings upsert at the cap must apply';
  refused := false;
  BEGIN
    INSERT INTO user_settings (user_id, key, value) VALUES ('zz-limit-test-2', 'k1001', 'v');
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  ASSERT refused, 'the 1001st setting must be refused';
  RAISE NOTICE 'ok: settings quota by key';
END $$;

\echo 'user_data_limits: all checks passed'
ROLLBACK;
