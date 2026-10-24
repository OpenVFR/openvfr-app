-- migrate:up

-- ════════════════════════════════════════════════════════════════════════════
-- Two-way sync support for the user_* tables: delete tombstones and a
-- last-write-wins guard, both enforced in the database so every client (web,
-- native, old app versions) gets the same rules.
--
-- Clients keep their own copy of these tables and reconcile with the server
-- in rounds (see packages/shared/src/cloudSync.ts). Without tombstones a
-- client cannot tell "this row was deleted on another device" from "this row
-- was created here and never uploaded", which either resurrected deletes or
-- deleted unuploaded rows. Without a write guard, a device that comes back
-- online with an old copy of a row overwrote a newer edit made elsewhere.
--
--   * user_sync_tombstones: one row per deleted (table, row id). Written by an
--     AFTER DELETE trigger, readable by the owner, never written by clients.
--   * Delete time: clients delete through sync_delete(), passing the time the
--     user deleted the row on the device (it may have been queued offline for
--     hours). Comparing that with the device's own updated_at values keeps a
--     delete followed by a re-create (same settings key) in the right order
--     even when the device clock differs from the server's. A plain DELETE
--     (older clients) uses the server time. Either way the tombstone is never
--     older than the deleted row's own updated_at, so a delete always beats
--     the version it removed.
--   * BEFORE INSERT: an insert whose updated_at is not newer than the row's
--     tombstone is a stale copy of a deleted row and is skipped. A newer one
--     (edited after the delete) wins and clears the tombstone.
--   * BEFORE UPDATE: an update older than the stored row is skipped, so a
--     late upload never overwrites a newer edit. Equal timestamps pass
--     (re-uploading the same version is harmless).
--   * Clock guard: client timestamps (updated_at, delete time) more than
--     2 minutes ahead of the server are clamped to now() + 2 minutes. One
--     device with a clock running fast could otherwise stamp rows far into
--     the future, after which every correct edit elsewhere loses. Clients
--     upload with return=representation and adopt the stored updated_at.
--   * Retention: tombstones older than 365 days are purged (opportunistically,
--     whenever the same user deletes something). A device that stays offline
--     longer than that may upload a row deleted elsewhere again.
--
-- Tombstones are only written for deletes made through PostgREST (a request
-- with JWT claims for the row's owner). Account deletion cascades through
-- these tables from the API's connection, which has no claims, so it leaves
-- no tombstones behind; the cascade on user_id removes the user's tombstones.
--
-- Tests: db/tests/sync_tombstones.test.sql (runs as the PostgREST roles in
-- one rolled-back transaction; safe on a restored production copy).
--
-- Rollback: the down migration drops the tombstones and RPC. Current clients
-- keep working against such a server (plain DELETE, no remote-delete
-- detection); deletes made meanwhile are not propagated to other devices.
--
-- Skipped rows are not errors: PostgREST answers 2xx either way (they are
-- just absent from a return=representation response), so a client
-- re-uploading an outdated row learns about the newer version (or the
-- tombstone) on its next round and applies it locally.
-- ════════════════════════════════════════════════════════════════════════════

-- Clients read this as `?table_name=eq.X` for their own user: the primary
-- key (user_id, table_name, row_id) serves that query, no extra index.
CREATE TABLE IF NOT EXISTS user_sync_tombstones (
  user_id     TEXT         NOT NULL REFERENCES ba_user (id) ON DELETE CASCADE,
  table_name  TEXT         NOT NULL,
  row_id      TEXT         NOT NULL,
  deleted_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, table_name, row_id)
);

ALTER TABLE user_sync_tombstones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_sync_tombstones_own ON user_sync_tombstones;
CREATE POLICY user_sync_tombstones_own ON user_sync_tombstones
  FOR SELECT USING (auth_user_id() = user_id);
GRANT SELECT ON user_sync_tombstones TO authenticated;
REVOKE ALL ON user_sync_tombstones FROM anon, martin_ro;

-- Rows already stamped in the future (a device with a fast clock, before
-- this migration) would make every later edit of them lose against the
-- update guard below. Bring them back to now, before the guard exists.
-- Devices holding such a row see their copy as newer, upload it once, and
-- adopt the clamped time the server stores.
UPDATE user_routes            SET updated_at = now() WHERE updated_at > now() + interval '2 minutes';
UPDATE user_aircraft_profiles SET updated_at = now() WHERE updated_at > now() + interval '2 minutes';
UPDATE user_waypoints         SET updated_at = now() WHERE updated_at > now() + interval '2 minutes';
UPDATE user_settings          SET updated_at = now() WHERE updated_at > now() + interval '2 minutes';
UPDATE user_flight_logs       SET updated_at = now() WHERE updated_at > now() + interval '2 minutes';

-- Row identity per table: user_settings rows are addressed by key (their id
-- is a server-side UUID clients never see), every other table by id.
-- TG_ARGV[0] names the identity column.

CREATE OR REPLACE FUNCTION sync_record_tombstone() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  rid    TEXT := to_jsonb(OLD) ->> TG_ARGV[0];
  asked  TEXT := current_setting('sync.deleted_at', true);
  del_at TIMESTAMPTZ := COALESCE(NULLIF(asked, '')::timestamptz, now());
  -- Not auth_user_id(): on a connection that has served a PostgREST request
  -- the claims setting can be '' outside a request, and ''::json throws --
  -- which would make every delete in such a session fail.
  caller TEXT := NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub';
BEGIN
  IF caller IS NULL OR caller <> OLD.user_id THEN
    RETURN OLD;
  END IF;
  INSERT INTO user_sync_tombstones (user_id, table_name, row_id, deleted_at)
  VALUES (OLD.user_id, TG_TABLE_NAME, rid, GREATEST(del_at, OLD.updated_at))
  ON CONFLICT (user_id, table_name, row_id)
    DO UPDATE SET deleted_at = GREATEST(user_sync_tombstones.deleted_at, EXCLUDED.deleted_at);
  DELETE FROM user_sync_tombstones
   WHERE user_id = OLD.user_id AND deleted_at < now() - interval '365 days';
  RETURN OLD;
END $$;

CREATE OR REPLACE FUNCTION sync_guard_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  rid TEXT := to_jsonb(NEW) ->> TG_ARGV[0];
  tomb TIMESTAMPTZ;
BEGIN
  NEW.updated_at := LEAST(NEW.updated_at, now() + interval '2 minutes');
  SELECT deleted_at INTO tomb FROM user_sync_tombstones
   WHERE user_id = NEW.user_id AND table_name = TG_TABLE_NAME AND row_id = rid;
  IF tomb IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.updated_at <= tomb THEN
    RETURN NULL;  -- stale copy of a deleted row
  END IF;
  DELETE FROM user_sync_tombstones
   WHERE user_id = NEW.user_id AND table_name = TG_TABLE_NAME AND row_id = rid;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION sync_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := LEAST(NEW.updated_at, now() + interval '2 minutes');
  IF NEW.updated_at < OLD.updated_at THEN
    RETURN NULL;  -- older than what the server has
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE
  t   TEXT;
  col TEXT;
BEGIN
  FOR t, col IN VALUES
    ('user_routes', 'id'), ('user_aircraft_profiles', 'id'), ('user_waypoints', 'id'),
    ('user_settings', 'key'), ('user_flight_logs', 'id')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS sync_tombstone ON %I', t);
    EXECUTE format('CREATE TRIGGER sync_tombstone AFTER DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION sync_record_tombstone(%L)', t, col);
    EXECUTE format('DROP TRIGGER IF EXISTS sync_guard_insert ON %I', t);
    EXECUTE format('CREATE TRIGGER sync_guard_insert BEFORE INSERT ON %I
                    FOR EACH ROW EXECUTE FUNCTION sync_guard_insert(%L)', t, col);
    EXECUTE format('DROP TRIGGER IF EXISTS sync_guard_update ON %I', t);
    EXECUTE format('CREATE TRIGGER sync_guard_update BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION sync_guard_update()', t);
  END LOOP;
END $$;

-- Delete one of the caller's rows, recording `p_deleted_at` (when the user
-- deleted it on the device) as the delete time. SECURITY INVOKER: RLS and the
-- caller's DELETE grants apply exactly as for a plain DELETE.
-- POST /rest/rpc/sync_delete {"p_table": ..., "p_id": ..., "p_deleted_at": ...}
CREATE OR REPLACE FUNCTION sync_delete(p_table TEXT, p_id TEXT, p_deleted_at TIMESTAMPTZ)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  col TEXT := CASE p_table
    WHEN 'user_routes'            THEN 'id'
    WHEN 'user_aircraft_profiles' THEN 'id'
    WHEN 'user_waypoints'         THEN 'id'
    WHEN 'user_flight_logs'       THEN 'id'
    WHEN 'user_settings'          THEN 'key'
  END;
BEGIN
  IF col IS NULL THEN
    RAISE EXCEPTION 'not a synced table: %', p_table USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('sync.deleted_at',
    LEAST(COALESCE(p_deleted_at, now()), now() + interval '2 minutes')::text, true);
  EXECUTE format('DELETE FROM %I WHERE %I = CAST($1 AS %s)', p_table, col,
                 CASE col WHEN 'key' THEN 'text' ELSE 'uuid' END)
    USING p_id;
  PERFORM set_config('sync.deleted_at', '', true);
END $$;
-- Only signed-in users may call it. martin_ro receives EXECUTE on new
-- functions through default privileges (least_privilege_roles); take it back.
-- The trigger functions cannot be called directly (they return trigger).
REVOKE ALL ON FUNCTION sync_delete(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, martin_ro;
GRANT EXECUTE ON FUNCTION sync_delete(TEXT, TEXT, TIMESTAMPTZ) TO authenticated;

-- Make the new objects visible to a running PostgREST without a restart.
NOTIFY pgrst, 'reload schema';

-- migrate:down

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_routes', 'user_aircraft_profiles', 'user_waypoints', 'user_settings', 'user_flight_logs']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS sync_tombstone ON %I', t);
    EXECUTE format('DROP TRIGGER IF EXISTS sync_guard_insert ON %I', t);
    EXECUTE format('DROP TRIGGER IF EXISTS sync_guard_update ON %I', t);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS sync_delete(TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS sync_record_tombstone();
DROP FUNCTION IF EXISTS sync_guard_insert();
DROP FUNCTION IF EXISTS sync_guard_update();
DROP TABLE IF EXISTS user_sync_tombstones;
