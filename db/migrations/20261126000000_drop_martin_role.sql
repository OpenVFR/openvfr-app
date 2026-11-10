-- migrate:up
-- Martin (the MVT tile server) is retired: every map layer is static
-- PMTiles/GeoJSON, and Azure never ran it. Its read-only role goes too.
-- The owner (openvfr, CREATEROLE) created the role, so it may revoke the
-- grants it gave and drop it; no superuser needed (Azure has none).

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'openvfr_martin') THEN
    ALTER DEFAULT PRIVILEGES FOR ROLE openvfr IN SCHEMA public
      REVOKE SELECT ON TABLES FROM openvfr_martin;
    ALTER DEFAULT PRIVILEGES FOR ROLE openvfr IN SCHEMA public
      REVOKE EXECUTE ON FUNCTIONS FROM openvfr_martin;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM openvfr_martin;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM openvfr_martin;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM openvfr_martin;
    REVOKE USAGE ON SCHEMA public FROM openvfr_martin;
    DROP ROLE openvfr_martin;
  END IF;
END $$;

-- migrate:down
-- Not recreated: nothing connects as openvfr_martin any more.
