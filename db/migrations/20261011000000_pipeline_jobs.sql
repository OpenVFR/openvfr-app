-- migrate:up

-- ════════════════════════════════════════════════════════════════════════════
-- Data-pipeline run history + operator-requested runs.
--
-- One row per run of one pipeline job for one country. Jobs are the data
-- pipeline's refresh units (see apps/api/src/pipeline.ts for the list the
-- admin API accepts, e.g. 'ofmx' = the AIRAC aviation datasets).
--
-- Two writers:
--   * the pipeline's scheduled jobs insert a 'running' row (trigger
--     'schedule') when they start working on a country and finish it as
--     'ok' / 'failed' with a short message and the tail of the job's log;
--   * the admin API inserts a 'queued' row (trigger 'admin') when an
--     operator asks for a run; the pipeline picks queued rows up, runs them
--     and finishes them the same way.
--
-- At most one queued-or-running row per (job, country): the partial unique
-- index makes a second request (or a scheduled run starting while an
-- operator's run is active) fail instead of running the same job twice.
--
-- Unlike data_loads (last success only), this keeps failures, so a refresh
-- that keeps failing is visible instead of the data silently ageing.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pipeline_jobs (
  id            BIGSERIAL    PRIMARY KEY,
  job           TEXT         NOT NULL CHECK (job ~ '^[a-z][a-z0-9_]{0,31}$'),
  country       CHAR(2)      NOT NULL CHECK (country ~ '^[a-z]{2}$'),
  trigger       TEXT         NOT NULL DEFAULT 'admin' CHECK (trigger IN ('schedule', 'admin')),
  -- Admin email for trigger 'admin'; NULL for scheduled runs.
  requested_by  TEXT,
  requested_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  status        TEXT         NOT NULL DEFAULT 'queued'
                             CHECK (status IN ('queued', 'running', 'ok', 'failed')),
  -- One-line summary (e.g. the last error line).
  message       TEXT,
  -- Last lines of the run's output, capped by the pipeline (a few KB).
  log_tail      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS pipeline_jobs_one_active
  ON pipeline_jobs (job, country) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS pipeline_jobs_recent
  ON pipeline_jobs (country, job, requested_at DESC);

-- api: reads history; may only queue a request (job, country, who). It
-- cannot set status/trigger/result columns, so it can never fake a run.
GRANT SELECT ON pipeline_jobs TO api_app;
GRANT INSERT (job, country, requested_by) ON pipeline_jobs TO api_app;
GRANT USAGE ON SEQUENCE pipeline_jobs_id_seq TO api_app;

-- api: per-dataset load metadata (cycle, last success, row count) for the
-- admin UI's country detail.
GRANT SELECT ON data_loads TO api_app;

-- cron: records runs, picks up queued requests, prunes old history.
GRANT SELECT, INSERT, UPDATE, DELETE ON pipeline_jobs TO cron_app;
GRANT USAGE, SELECT ON SEQUENCE pipeline_jobs_id_seq TO cron_app;

-- Log tails may contain server paths: not for PostgREST clients or the
-- tile server (martin_ro gets SELECT on new tables by default privileges).
REVOKE ALL ON pipeline_jobs FROM anon, authenticated, martin_ro;

-- migrate:down

REVOKE SELECT ON data_loads FROM api_app;
DROP TABLE IF EXISTS pipeline_jobs;
