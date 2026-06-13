import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import type { JobParameters } from '../core/types';
import type { FinishExecutionInput, FinishStepInput, JobRepository } from './job-repository';
import type {
  ContextOwnerType,
  JobExecution,
  JobInstance,
  StepCounts,
  StepExecution,
} from './types';

interface ExecutionRow extends RowDataPacket {
  id: number | string;
  instance_id: number | string;
  status: string;
  exit_status: string | null;
  started_at: Date | string;
  ended_at: Date | string | null;
  duration_ms: number | string | null;
  error: string | null;
  items_collected: number | string | null;
  result_meta: unknown;
}

interface StepRow extends RowDataPacket {
  id: number | string;
  job_execution_id: number | string;
  step_name: string;
  seq_no: number | string;
  status: string;
  exit_status: string | null;
  started_at: Date | string;
  ended_at: Date | string | null;
  duration_ms: number | string | null;
  read_count: number | string;
  write_count: number | string;
  skip_count: number | string;
  error: string | null;
}

interface ContextRow extends RowDataPacket {
  ctx: unknown;
}

/**
 * MySQL-backed {@link JobRepository}. Uses an injected `mysql2` connection pool
 * (`mysql2` is a peer dependency) and prepared statements throughout.
 *
 * Apply `src/schema.sql` before use; stepflow ships no migration tooling.
 */
export class MySqlJobRepository implements JobRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async resolveInstance(jobName: string, jobKey: string): Promise<JobInstance> {
    const [result] = await this.#pool.execute<ResultSetHeader>(
      `INSERT INTO job_instance (job_name, job_key, created_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [jobName, jobKey, new Date()],
    );
    return { id: result.insertId, jobName, jobKey };
  }

  async findLastExecution(instanceId: number): Promise<JobExecution | null> {
    const [rows] = await this.#pool.execute<ExecutionRow[]>(
      `SELECT * FROM job_execution WHERE instance_id = ? ORDER BY id DESC LIMIT 1`,
      [instanceId],
    );
    const row = rows[0];
    return row ? mapExecution(row) : null;
  }

  async createExecution(instanceId: number, params: JobParameters): Promise<JobExecution> {
    const startedAt = new Date();
    const [result] = await this.#pool.execute<ResultSetHeader>(
      `INSERT INTO job_execution (instance_id, status, started_at) VALUES (?, 'STARTED', ?)`,
      [instanceId, startedAt],
    );
    const executionId = result.insertId;

    const entries = Object.entries(params);
    if (entries.length > 0) {
      const placeholders = entries.map(() => '(?, ?, ?, 1)').join(', ');
      const values = entries.flatMap(([key, value]) => [executionId, key, value]);
      await this.#pool.execute(
        `INSERT INTO job_execution_params (execution_id, param_key, param_value, identifying)
         VALUES ${placeholders}`,
        values,
      );
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
    const now = new Date();
    await this.#pool.execute(
      `UPDATE job_execution
       SET status = ?, exit_status = ?, ended_at = ?,
           duration_ms = TIMESTAMPDIFF(MICROSECOND, started_at, ?) DIV 1000,
           error = ?, items_collected = ?, result_meta = ?
       WHERE id = ?`,
      [
        input.status,
        input.exitStatus,
        now,
        now,
        input.error ?? null,
        input.itemsCollected ?? null,
        input.resultMeta !== undefined ? JSON.stringify(input.resultMeta) : null,
        executionId,
      ],
    );
  }

  async startStep(executionId: number, stepName: string, seqNo: number): Promise<StepExecution> {
    const startedAt = new Date();
    const [result] = await this.#pool.execute<ResultSetHeader>(
      `INSERT INTO step_execution (job_execution_id, step_name, seq_no, status, started_at)
       VALUES (?, ?, ?, 'STARTED', ?)`,
      [executionId, stepName, seqNo, startedAt],
    );
    return {
      id: result.insertId,
      jobExecutionId: executionId,
      stepName,
      seqNo,
      status: 'STARTED',
      exitStatus: null,
      startedAt,
      endedAt: null,
      durationMs: null,
      counts: { readCount: 0, writeCount: 0, skipCount: 0 },
      error: null,
    };
  }

  async finishStep(stepExecutionId: number, input: FinishStepInput): Promise<void> {
    const now = new Date();
    await this.#pool.execute(
      `UPDATE step_execution
       SET status = ?, exit_status = ?, ended_at = ?,
           duration_ms = COALESCE(?, TIMESTAMPDIFF(MICROSECOND, started_at, ?) DIV 1000),
           read_count = COALESCE(?, read_count),
           write_count = COALESCE(?, write_count),
           skip_count = COALESCE(?, skip_count),
           error = ?
       WHERE id = ?`,
      [
        input.status,
        input.exitStatus,
        now,
        input.durationMs ?? null,
        now,
        input.counts?.readCount ?? null,
        input.counts?.writeCount ?? null,
        input.counts?.skipCount ?? null,
        input.error ?? null,
        stepExecutionId,
      ],
    );
  }

  async findStepExecutions(executionId: number): Promise<readonly StepExecution[]> {
    const [rows] = await this.#pool.execute<StepRow[]>(
      `SELECT * FROM step_execution WHERE job_execution_id = ? ORDER BY id ASC`,
      [executionId],
    );
    return rows.map(mapStep);
  }

  async saveContext(
    ownerType: ContextOwnerType,
    ownerId: number,
    ctx: Record<string, unknown>,
  ): Promise<void> {
    await this.#pool.execute(
      `INSERT INTO execution_context (owner_type, owner_id, ctx, updated_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE ctx = VALUES(ctx), updated_at = VALUES(updated_at)`,
      [ownerType, ownerId, JSON.stringify(ctx), new Date()],
    );
  }

  async loadContext(
    ownerType: ContextOwnerType,
    ownerId: number,
  ): Promise<Record<string, unknown> | null> {
    const [rows] = await this.#pool.execute<ContextRow[]>(
      `SELECT ctx FROM execution_context WHERE owner_type = ? AND owner_id = ?`,
      [ownerType, ownerId],
    );
    const row = rows[0];
    return row ? parseJsonObject(row.ctx) : null;
  }
}

function mapExecution(row: ExecutionRow): JobExecution {
  return {
    id: Number(row.id),
    instanceId: Number(row.instance_id),
    status: toBatchStatus(row.status),
    exitStatus: row.exit_status,
    startedAt: toDate(row.started_at),
    endedAt: row.ended_at === null ? null : toDate(row.ended_at),
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
    startedAt: toDate(row.started_at),
    endedAt: row.ended_at === null ? null : toDate(row.ended_at),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    counts,
    error: row.error,
  };
}

function toBatchStatus(value: string): JobExecution['status'] {
  return value as JobExecution['status'];
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    return JSON.parse(value) as Record<string, unknown>;
  }
  return (value ?? {}) as Record<string, unknown>;
}

function parseJsonObjectOrNull(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parseJsonObject(value);
}
