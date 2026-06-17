// better-sqlite3 is synchronous; the JobRepository interface is async (Promises).
// These methods wrap sync driver calls, so they intentionally have no `await`.
/* eslint-disable @typescript-eslint/require-await */
import type { Database } from 'better-sqlite3';

import type {
  ContextOwnerType,
  FinishExecutionInput,
  FinishStepInput,
  JobExecution,
  JobInstance,
  JobParameters,
  JobRepository,
  StepCounts,
  StepExecution,
} from '@kmgeon/stepflow-core';

interface ExecutionRow {
  id: number | bigint;
  instance_id: number | bigint;
  status: string;
  exit_status: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | bigint | null;
  error: string | null;
  items_collected: number | bigint | null;
  result_meta: string | null;
}

interface StepRow {
  id: number | bigint;
  job_execution_id: number | bigint;
  step_name: string;
  seq_no: number | bigint;
  status: string;
  exit_status: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | bigint | null;
  read_count: number | bigint;
  write_count: number | bigint;
  skip_count: number | bigint;
  attempts: number | bigint;
  error: string | null;
}

interface ContextRow {
  ctx: string;
}

/**
 * SQLite-backed {@link JobRepository}. Uses an injected `better-sqlite3`
 * `Database` (`better-sqlite3` is a peer dependency) via prepared statements.
 * The synchronous driver is wrapped in async methods to satisfy the contract.
 *
 * Apply `src/schema.sqlite.sql` before use; stepflow ships no migration tooling.
 */
export class SqliteJobRepository implements JobRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async resolveInstance(jobName: string, jobKey: string): Promise<JobInstance> {
    const row = this.#db
      .prepare(
        `INSERT INTO job_instance (job_name, job_key, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(job_name, job_key) DO UPDATE SET job_name = excluded.job_name
         RETURNING id`,
      )
      .get(jobName, jobKey, new Date().toISOString()) as { id: number | bigint };
    return { id: Number(row.id), jobName, jobKey };
  }

  async findLastExecution(instanceId: number): Promise<JobExecution | null> {
    const row = this.#db
      .prepare(`SELECT * FROM job_execution WHERE instance_id = ? ORDER BY id DESC LIMIT 1`)
      .get(instanceId) as ExecutionRow | undefined;
    return row ? mapExecution(row) : null;
  }

  async createExecution(instanceId: number, params: JobParameters): Promise<JobExecution> {
    const startedAt = new Date();
    const info = this.#db
      .prepare(
        `INSERT INTO job_execution (instance_id, status, started_at) VALUES (?, 'STARTED', ?)`,
      )
      .run(instanceId, startedAt.toISOString());
    const executionId = Number(info.lastInsertRowid);

    const entries = Object.entries(params);
    if (entries.length > 0) {
      const placeholders = entries.map(() => '(?, ?, ?, 1)').join(', ');
      const values = entries.flatMap(([key, value]) => [executionId, key, value]);
      this.#db
        .prepare(
          `INSERT INTO job_execution_params (execution_id, param_key, param_value, identifying)
           VALUES ${placeholders}`,
        )
        .run(...values);
    }

    return {
      id: executionId,
      instanceId,
      status: 'STARTED',
      exitStatus: null,
      startedAt,
      endedAt: null,
      durationMs: null,
      error: null,
      itemsCollected: null,
      resultMeta: null,
    };
  }

  async finishExecution(executionId: number, input: FinishExecutionInput): Promise<void> {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `UPDATE job_execution
         SET status = ?, exit_status = ?, ended_at = ?,
             duration_ms = CAST(round((julianday(?) - julianday(started_at)) * 86400000) AS INTEGER),
             error = ?, items_collected = ?, result_meta = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.exitStatus,
        now,
        now,
        input.error ?? null,
        input.itemsCollected ?? null,
        input.resultMeta !== undefined ? JSON.stringify(input.resultMeta) : null,
        executionId,
      );
  }

  async startStep(executionId: number, stepName: string, seqNo: number): Promise<StepExecution> {
    const startedAt = new Date();
    const info = this.#db
      .prepare(
        `INSERT INTO step_execution (job_execution_id, step_name, seq_no, status, started_at)
         VALUES (?, ?, ?, 'STARTED', ?)`,
      )
      .run(executionId, stepName, seqNo, startedAt.toISOString());
    return {
      id: Number(info.lastInsertRowid),
      jobExecutionId: executionId,
      stepName,
      seqNo,
      status: 'STARTED',
      exitStatus: null,
      startedAt,
      endedAt: null,
      durationMs: null,
      counts: { readCount: 0, writeCount: 0, skipCount: 0 },
      attempts: 1,
      error: null,
    };
  }

  async finishStep(stepExecutionId: number, input: FinishStepInput): Promise<void> {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `UPDATE step_execution
         SET status = ?, exit_status = ?, ended_at = ?,
             duration_ms = COALESCE(?, CAST(round((julianday(?) - julianday(started_at)) * 86400000) AS INTEGER)),
             read_count = COALESCE(?, read_count),
             write_count = COALESCE(?, write_count),
             skip_count = COALESCE(?, skip_count),
             attempts = COALESCE(?, attempts),
             error = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.exitStatus,
        now,
        input.durationMs ?? null,
        now,
        input.counts?.readCount ?? null,
        input.counts?.writeCount ?? null,
        input.counts?.skipCount ?? null,
        input.attempts ?? null,
        input.error ?? null,
        stepExecutionId,
      );
  }

  async findStepExecutions(executionId: number): Promise<readonly StepExecution[]> {
    const rows = this.#db
      .prepare(`SELECT * FROM step_execution WHERE job_execution_id = ? ORDER BY id ASC`)
      .all(executionId) as StepRow[];
    return rows.map(mapStep);
  }

  async saveContext(
    ownerType: ContextOwnerType,
    ownerId: number,
    ctx: Record<string, unknown>,
  ): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO execution_context (owner_type, owner_id, ctx, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(owner_type, owner_id) DO UPDATE SET ctx = excluded.ctx, updated_at = excluded.updated_at`,
      )
      .run(ownerType, ownerId, JSON.stringify(ctx), new Date().toISOString());
  }

  async loadContext(
    ownerType: ContextOwnerType,
    ownerId: number,
  ): Promise<Record<string, unknown> | null> {
    const row = this.#db
      .prepare(`SELECT ctx FROM execution_context WHERE owner_type = ? AND owner_id = ?`)
      .get(ownerType, ownerId) as ContextRow | undefined;
    return row ? parseJsonObject(row.ctx) : null;
  }
}

function mapExecution(row: ExecutionRow): JobExecution {
  return {
    id: Number(row.id),
    instanceId: Number(row.instance_id),
    status: toBatchStatus(row.status),
    exitStatus: row.exit_status,
    startedAt: new Date(row.started_at),
    endedAt: row.ended_at === null ? null : new Date(row.ended_at),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    error: row.error,
    itemsCollected: row.items_collected === null ? null : Number(row.items_collected),
    resultMeta: parseJsonObjectOrNull(row.result_meta),
  };
}

function mapStep(row: StepRow): StepExecution {
  const counts: StepCounts = {
    readCount: Number(row.read_count),
    writeCount: Number(row.write_count),
    skipCount: Number(row.skip_count),
  };
  return {
    id: Number(row.id),
    jobExecutionId: Number(row.job_execution_id),
    stepName: row.step_name,
    seqNo: Number(row.seq_no),
    status: toBatchStatus(row.status),
    exitStatus: row.exit_status,
    startedAt: new Date(row.started_at),
    endedAt: row.ended_at === null ? null : new Date(row.ended_at),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    counts,
    attempts: Number(row.attempts),
    error: row.error,
  };
}

function toBatchStatus(value: string): JobExecution['status'] {
  if (value === 'STARTED' || value === 'COMPLETED' || value === 'FAILED') {
    return value;
  }
  throw new Error(`SqliteJobRepository: unexpected batch status ${JSON.stringify(value)}`);
}

function parseJsonObject(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

function parseJsonObjectOrNull(value: string | null): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }
  return parseJsonObject(value);
}
