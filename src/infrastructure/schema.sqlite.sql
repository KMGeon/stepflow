-- stepflow metadata schema for SQLite (mirror of schema.sql).
-- Apply manually; stepflow ships no migration tooling.
-- Timestamps are ISO 8601 TEXT; JSON payloads are TEXT.
-- Enable foreign keys per-connection with `PRAGMA foreign_keys = ON`.

CREATE TABLE IF NOT EXISTS job_instance (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name    TEXT NOT NULL,
  job_key     TEXT NOT NULL,            -- sha256(jobName + identifying params)
  created_at  TEXT NOT NULL,
  UNIQUE (job_name, job_key)
);

CREATE TABLE IF NOT EXISTS job_execution (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id     INTEGER NOT NULL,
  status          TEXT    NOT NULL,        -- STARTED | COMPLETED | FAILED
  exit_status     TEXT,
  started_at      TEXT    NOT NULL,
  ended_at        TEXT,
  duration_ms     INTEGER,
  error           TEXT,
  items_collected INTEGER,                 -- L2: result metric
  result_meta     TEXT,                    -- L2: per-job result metadata (JSON text)
  FOREIGN KEY (instance_id) REFERENCES job_instance (id)
);
CREATE INDEX IF NOT EXISTS idx_execution_instance ON job_execution (instance_id, id);

CREATE TABLE IF NOT EXISTS job_execution_params (
  execution_id  INTEGER NOT NULL,
  param_key     TEXT    NOT NULL,
  param_value   TEXT,
  identifying   INTEGER NOT NULL DEFAULT 1, -- included in job_key?
  PRIMARY KEY (execution_id, param_key),
  FOREIGN KEY (execution_id) REFERENCES job_execution (id)
);

CREATE TABLE IF NOT EXISTS step_execution (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_execution_id  INTEGER NOT NULL,
  step_name         TEXT    NOT NULL,
  seq_no            INTEGER NOT NULL,       -- step's position in the definition
  status            TEXT    NOT NULL,       -- STARTED | COMPLETED | FAILED
  exit_status       TEXT,                   -- branch decision / restart path
  started_at        TEXT    NOT NULL,
  ended_at          TEXT,
  duration_ms       INTEGER,
  read_count        INTEGER NOT NULL DEFAULT 0, -- L2 (chunk)
  write_count       INTEGER NOT NULL DEFAULT 0,
  skip_count        INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 1, -- runs of the step body (1 + retries)
  error             TEXT,
  FOREIGN KEY (job_execution_id) REFERENCES job_execution (id)
);
CREATE INDEX IF NOT EXISTS idx_step_execution ON step_execution (job_execution_id, id);

CREATE TABLE IF NOT EXISTS execution_context (
  owner_type  TEXT    NOT NULL,             -- JOB | STEP | CHUNK
  owner_id    INTEGER NOT NULL,             -- job_execution.id or step_execution.id
  ctx         TEXT    NOT NULL,             -- serialized ExecutionContext (JSON text)
  updated_at  TEXT    NOT NULL,
  PRIMARY KEY (owner_type, owner_id)
);
