-- migrate:up

-- ════════════════════════════════════════════════════════════════════════════
-- Limits on per-user data written through PostgREST, plus two hardening
-- fixes. Clients only ever write their own rows (RLS), but nothing capped
-- how much: one account could store arbitrarily large rows or arbitrarily
-- many of them and fill the disk.
--
--   * Size: CHECK constraints per column, far above anything the apps
--     produce (a 10 h flight at 1 track point per second is ~5 MB of
--     track_json; a 100-waypoint route ~20 KB). NOT VALID: enforced for new
--     and updated rows only, existing rows are not re-checked.
--   * Count: a BEFORE INSERT trigger refuses a NEW row once the owner has
--     the maximum number of rows in that table. Upserts of an existing row
--     (sync re-uploads, edits) always pass, so hitting the cap never blocks
--     editing what is already there. Named user_quota so it runs after
--     sync_guard_insert (triggers fire in name order): a stale copy of a
--     deleted row is dropped by the guard before it is counted.
--   * auth_user_id() tolerates an empty claims setting (''::json throws),
--     the same fix sync_record_tombstone() already has: on a pooled
--     connection that has served a PostgREST request the setting can be ''
--     outside a request.
--   * martin_ro (tile server) never needs user data: revoke what the blanket
--     SELECT ON ALL TABLES grant in the least-privilege migration gave it.
--     RLS already hid every row from it; this removes the grant itself.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION auth_user_id() RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true), '')::json->>'sub'
$$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'martin_ro') THEN
    REVOKE ALL ON user_routes, user_aircraft_profiles, user_waypoints, user_settings,
                  user_flight_logs, user_sync_tombstones
      FROM martin_ro;
  END IF;
END $$;

-- ── Size limits ─────────────────────────────────────────────────────────────
ALTER TABLE user_routes DROP CONSTRAINT IF EXISTS user_routes_size_chk;
ALTER TABLE user_routes ADD CONSTRAINT user_routes_size_chk CHECK (
  octet_length(name) <= 1000
  AND octet_length(aircraft_id) <= 200
  AND octet_length(waypoints::text) <= 1048576
  AND octet_length(leg_overrides::text) <= 262144
) NOT VALID;

ALTER TABLE user_aircraft_profiles DROP CONSTRAINT IF EXISTS user_aircraft_profiles_size_chk;
ALTER TABLE user_aircraft_profiles ADD CONSTRAINT user_aircraft_profiles_size_chk CHECK (
  octet_length(data::text) <= 262144
) NOT VALID;

ALTER TABLE user_waypoints DROP CONSTRAINT IF EXISTS user_waypoints_size_chk;
ALTER TABLE user_waypoints ADD CONSTRAINT user_waypoints_size_chk CHECK (
  octet_length(name) <= 1000
  AND octet_length(folder) <= 1000
) NOT VALID;

ALTER TABLE user_settings DROP CONSTRAINT IF EXISTS user_settings_size_chk;
ALTER TABLE user_settings ADD CONSTRAINT user_settings_size_chk CHECK (
  octet_length(key) <= 200
  AND octet_length(value) <= 1048576
) NOT VALID;

ALTER TABLE user_flight_logs DROP CONSTRAINT IF EXISTS user_flight_logs_size_chk;
ALTER TABLE user_flight_logs ADD CONSTRAINT user_flight_logs_size_chk CHECK (
  octet_length(track_json) <= 16777216
  AND octet_length(aircraft_id) <= 200
  AND octet_length(registration) <= 64
  AND octet_length(departure_icao) <= 64
  AND octet_length(arrival_icao) <= 64
) NOT VALID;

-- ── Row-count quota ─────────────────────────────────────────────────────────
-- TG_ARGV[0]: the row's identity column (id, or key for settings).
-- TG_ARGV[1]: the most rows one user may have in this table.
-- Runs as the caller: RLS limits the count to the caller's own rows, which
-- is exactly the set being capped.
CREATE OR REPLACE FUNCTION user_quota_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  id_col TEXT := TG_ARGV[0];
  max_rows INTEGER := TG_ARGV[1]::integer;
  rid TEXT := to_jsonb(NEW) ->> id_col;
  existing BOOLEAN;
  n INTEGER;
BEGIN
  -- An upsert of a row that already exists is an update, never a new row.
  -- Compare in the column's own type so the primary-key / unique index is used.
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE user_id = $1 AND %I = CAST($2 AS %s))',
                 TG_TABLE_NAME, id_col, CASE id_col WHEN 'key' THEN 'text' ELSE 'uuid' END)
    INTO existing USING NEW.user_id, rid;
  IF existing THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT count(*) FROM %I WHERE user_id = $1', TG_TABLE_NAME)
    INTO n USING NEW.user_id;
  IF n >= max_rows THEN
    -- check_violation, like the size caps: PostgREST answers 400, which the
    -- sync engine treats as a permanent rejection (it maps
    -- program_limit_exceeded to 500, which would be retried forever).
    RAISE EXCEPTION 'quota exceeded: at most % rows in %', max_rows, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE
  t   TEXT;
  col TEXT;
  lim INTEGER;
BEGIN
  FOR t, col, lim IN VALUES
    ('user_routes', 'id', 5000), ('user_aircraft_profiles', 'id', 500),
    ('user_waypoints', 'id', 20000), ('user_settings', 'key', 1000),
    ('user_flight_logs', 'id', 10000)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS user_quota ON %I', t);
    EXECUTE format('CREATE TRIGGER user_quota BEFORE INSERT ON %I
                    FOR EACH ROW EXECUTE FUNCTION user_quota_guard(%L, %L)', t, col, lim);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

-- migrate:down

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_routes', 'user_aircraft_profiles', 'user_waypoints', 'user_settings', 'user_flight_logs']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS user_quota ON %I', t);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_size_chk');
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS user_quota_guard();

CREATE OR REPLACE FUNCTION auth_user_id() RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT current_setting('request.jwt.claims', true)::json->>'sub'
$$;

-- martin_ro's grants on the user tables are not restored: it never needed them.
