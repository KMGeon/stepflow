import type { RunJobResult } from './run-job';
import type { RetryInfo } from './retry';
import type { ChunkInfo } from './chunk';
import type { ExitStatus, JobParameters, Logger, StepContext } from '../types';

/** Job-scoped context handed to {@link JobListener.beforeJob}/{@link JobListener.afterJob}. */
export interface JobLifecycleContext {
  readonly jobName: string;
  /** JobInstance id (jobName + identifying-params hash). */
  readonly instanceId: number;
  /** This JobExecution's id. */
  readonly executionId: number;
  readonly params: JobParameters;
  readonly logger: Logger;
}

/** Identifies the step a step-scoped listener call refers to. */
export interface StepInfo {
  readonly stepName: string;
  /** 1-based sequence number of the step within the job definition. */
  readonly seqNo: number;
}

/** The result of running a single step, handed to {@link JobListener.afterStep}. */
export interface StepOutcome {
  readonly status: 'COMPLETED' | 'FAILED';
  readonly exitStatus: ExitStatus;
  readonly durationMs: number;
  /** Failure message, present only when `status` is `'FAILED'`. */
  readonly error?: string;
}

/**
 * Optional observer of a job run. Every method is optional. Listeners are for
 * observation and side effects (notifications, metrics) — never flow control,
 * which is owned by step return values and `branch`. A throwing listener is
 * isolated by the engine (logged, not rethrown) and never aborts the job.
 *
 * Listener methods fire only for steps that actually execute: on restart, steps
 * whose prior success is carried forward emit no `beforeStep`/`afterStep`.
 */
export interface JobListener {
  beforeJob?(ctx: JobLifecycleContext): void | Promise<void>;
  afterJob?(ctx: JobLifecycleContext, result: RunJobResult): void | Promise<void>;
  beforeStep?(ctx: StepContext, step: StepInfo): void | Promise<void>;
  afterStep?(ctx: StepContext, step: StepInfo, outcome: StepOutcome): void | Promise<void>;
  onStepError?(ctx: StepContext, step: StepInfo, error: unknown): void | Promise<void>;
  /** Fired after a step attempt fails but will be retried (see {@link RetryInfo}). */
  onRetry?(ctx: StepContext, step: StepInfo, info: RetryInfo): void | Promise<void>;
  /** Fired after each committed chunk of a chunk step (see {@link ChunkInfo}). */
  onChunk?(ctx: StepContext, step: StepInfo, info: ChunkInfo): void | Promise<void>;
}
