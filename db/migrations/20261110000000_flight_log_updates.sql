-- migrate:up

-- Flight logs become editable by their owner, and can carry the planned route.
--
-- Until now user_flight_logs was insert-only (plus delete): a completed log
-- never changed. Three things need to change an existing log:
--   * setting or correcting the aircraft a log was flown with;
--   * merging a log broken by a GPS loss with the one that continues it
--     (the first log gets the combined track, the second is deleted);
--   * attaching the route that was planned for the flight.
-- Updates go through the same guard as the other synced tables
-- (sync_guard_update, see 20261020000000_sync_tombstones): last write wins by
-- updated_at, with client timestamps clamped to at most 2 minutes ahead.
--
-- Clients upload a new log as a plain insert (ON CONFLICT DO NOTHING), which
-- needs no UPDATE privilege; only a log the server already has is sent as an
-- upsert. Older apps keep working against this schema, and newer apps keep
-- uploading new logs against a server without this migration.

ALTER TABLE user_flight_logs ADD COLUMN IF NOT EXISTS route_json TEXT;

COMMENT ON COLUMN user_flight_logs.route_json IS
  'Planned route at the time of the flight: JSON {name?, waypoints, legOverrides, aircraftId?}; NULL when none.';

ALTER TABLE user_flight_logs DROP CONSTRAINT IF EXISTS user_flight_logs_size_chk;
ALTER TABLE user_flight_logs ADD CONSTRAINT user_flight_logs_size_chk CHECK (
  octet_length(track_json) <= 16777216
  AND octet_length(aircraft_id) <= 200
  AND octet_length(registration) <= 64
  AND octet_length(departure_icao) <= 64
  AND octet_length(arrival_icao) <= 64
  AND octet_length(coalesce(route_json, '')) <= 1048576
) NOT VALID;

DROP POLICY IF EXISTS user_flight_logs_update ON user_flight_logs;
CREATE POLICY user_flight_logs_update ON user_flight_logs
  FOR UPDATE USING (auth_user_id() = user_id) WITH CHECK (auth_user_id() = user_id);

GRANT UPDATE ON user_flight_logs TO authenticated;

NOTIFY pgrst, 'reload schema';

-- migrate:down

REVOKE UPDATE ON user_flight_logs FROM authenticated;
DROP POLICY IF EXISTS user_flight_logs_update ON user_flight_logs;

ALTER TABLE user_flight_logs DROP CONSTRAINT IF EXISTS user_flight_logs_size_chk;
ALTER TABLE user_flight_logs ADD CONSTRAINT user_flight_logs_size_chk CHECK (
  octet_length(track_json) <= 16777216
  AND octet_length(aircraft_id) <= 200
  AND octet_length(registration) <= 64
  AND octet_length(departure_icao) <= 64
  AND octet_length(arrival_icao) <= 64
) NOT VALID;

ALTER TABLE user_flight_logs DROP COLUMN IF EXISTS route_json;

NOTIFY pgrst, 'reload schema';
