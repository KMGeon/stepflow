-- stepflow metadata schema (L3 — Spring Batch faithful).
-- Apply manually; stepflow ships no migration tooling.
-- MySQL 8+. All timestamps are DATETIME(3) (millisecond precision).

CREATE TABLE IF NOT EXISTS job_instance (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  job_name    VARCHAR(128) NOT NULL,
  job_key     CHAR(64)     NOT NULL,            -- sha256(jobName + identifying params)
  created_at  DATETIME(3)  NOT NULL,
  UNIQUE KEY uq_instance (job_name, job_key)
);

CREATE TABLE IF NOT EXISTS job_execution (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  instance_id     BIGINT       NOT NULL,
  status          VARCHAR(32)  NOT NULL,        -- STARTED | COMPLETED | FAILED
  exit_status     VARCHAR(64)  NULL,
  started_at      DATETIME(3)  NOT NULL,
  ended_at        DATETIME(3)  NULL,
  duration_ms     BIGINT       NULL,
  error           TEXT         NULL,
  items_collected INT          NULL,            -- L2: result metric
  result_meta     JSON         NULL,            -- L2: per-job result metadata
  INDEX idx_execution_instance (instance_id, id),
  CONSTRAINT fk_execution_instance FOREIGN KEY (instance_id) REFERENCES job_instance (id)
);

CREATE TABLE IF NOT EXISTS job_execution_params (
  execution_id  BIGINT        NOT NULL,
  param_key     VARCHAR(128)  NOT NULL,
  param_value   VARCHAR(1024) NULL,
  identifying   TINYINT(1)    NOT NULL DEFAULT 1, -- included in job_key?
  PRIMARY KEY (execution_id, param_key),
  CONSTRAINT fk_params_execution FOREIGN KEY (execution_id) REFERENCES job_execution (id)
);

CREATE TABLE IF NOT EXISTS step_execution (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  job_execution_id  BIGINT       NOT NULL,
  step_name         VARCHAR(128) NOT NULL,
  seq_no            INT          NOT NULL,       -- step's position in the definition
  status            VARCHAR(32)  NOT NULL,       -- STARTED | COMPLETED | FAILED
  exit_status       VARCHAR(64)  NULL,           -- branch decision / restart path
  started_at        DATETIME(3)  NOT NULL,
  ended_at          DATETIME(3)  NULL,
  duration_ms       BIGINT       NULL,
  read_count        INT          NOT NULL DEFAULT 0, -- L2 (chunk; 0 in v0.1)
  write_count       INT          NOT NULL DEFAULT 0,
  skip_count        INT          NOT NULL DEFAULT 0,
  error             TEXT         NULL,
  INDEX idx_step_execution (job_execution_id, id),
  CONSTRAINT fk_step_execution FOREIGN KEY (job_execution_id) REFERENCES job_execution (id)
);

CREATE TABLE IF NOT EXISTS execution_context (
  owner_type  VARCHAR(16) NOT NULL,             -- JOB | STEP
  owner_id    BIGINT      NOT NULL,             -- job_execution.id or step_execution.id
  ctx         JSON        NOT NULL,             -- serialized ExecutionContext (shared)
  updated_at  DATETIME(3) NOT NULL,
  PRIMARY KEY (owner_type, owner_id)
);
