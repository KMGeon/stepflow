import type { BatchStatus, ExitStatus } from '../types';

/** A logical run unit identified by `(jobName + identifying-params hash)`. */
export interface JobInstance {
  readonly id: number;
  readonly jobName: string;
  readonly jobKey: string;
}

/** Arbitrary per-execution result metadata (persisted as JSON). */
export type ResultMeta = Record<string, unknown>;

/** One execution (run) of a {@link JobInstance}. */
export interface JobExecution {
  readonly id: number;
  readonly instanceId: number;
  readonly status: BatchStatus;
  readonly exitStatus: ExitStatus | null;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly durationMs: number | null;
  readonly error: string | null;
  readonly itemsCollected: number | null;
  readonly resultMeta: ResultMeta | null;
}

/** Item-level counters for a step (populated by chunk processing; 0 in v0.1). */
export interface StepCounts {
  readonly readCount: number;
  readonly writeCount: number;
  readonly skipCount: number;
}

/** One execution of a single step within a {@link JobExecution}. */
export interface StepExecution {
  readonly id: number;
  readonly jobExecutionId: number;
  readonly stepName: string;
  readonly seqNo: number;
  readonly status: BatchStatus;
  readonly exitStatus: ExitStatus | null;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly durationMs: number | null;
  readonly counts: StepCounts;
  /** How many times the step body ran (1 + retries). */
  readonly attempts: number;
  readonly error: string | null;
}

/** Owner kind for an execution-context row. */
export type ContextOwnerType = 'JOB' | 'STEP';
