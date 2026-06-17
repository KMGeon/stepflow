import type { BatchStatus, ExitStatus, JobParameters } from '../types';
import type {
  ContextOwnerType,
  JobExecution,
  JobInstance,
  ResultMeta,
  StepCounts,
  StepExecution,
} from '../metadata/metadata';

/** Terminal state to record for a {@link JobExecution}. */
export interface FinishExecutionInput {
  /** Terminal batch status: `'COMPLETED'` or `'FAILED'`. */
  readonly status: Extract<BatchStatus, 'COMPLETED' | 'FAILED'>;
  readonly exitStatus: ExitStatus;
  readonly error?: string;
  readonly itemsCollected?: number;
  readonly resultMeta?: ResultMeta;
}

/** Terminal state to record for a {@link StepExecution}. */
export interface FinishStepInput {
  readonly status: Extract<BatchStatus, 'COMPLETED' | 'FAILED'>;
  readonly exitStatus: ExitStatus;
  readonly error?: string;
  readonly durationMs?: number;
  readonly counts?: Partial<StepCounts>;
  /** Number of times the step body ran (1 + retries). Defaults to the persisted value when omitted. */
  readonly attempts?: number;
}

/**
 * Persistence boundary for all job/step metadata and ExecutionContext.
 *
 * stepflow owns neither the database connection nor the storage engine — an
 * implementation is injected into {@link runJob}. Two implementations ship:
 * `InMemoryJobRepository` (this package) and `MySqlJobRepository`
 * (`@kmgeon/stepflow/infrastructure`); both satisfy the shared contract suite from
 * `@kmgeon/stepflow/test`.
 */
export interface JobRepository {
  /** Find or create the {@link JobInstance} for `(jobName, jobKey)`. */
  resolveInstance(jobName: string, jobKey: string): Promise<JobInstance>;

  /** The most recent execution of an instance, or `null` if it has never run. */
  findLastExecution(instanceId: number): Promise<JobExecution | null>;

  /** Create a fresh `STARTED` execution and persist its parameters. */
  createExecution(instanceId: number, params: JobParameters): Promise<JobExecution>;

  /** Record a terminal status for an execution. */
  finishExecution(executionId: number, input: FinishExecutionInput): Promise<void>;

  /** Create a fresh `STARTED` step execution. */
  startStep(executionId: number, stepName: string, seqNo: number): Promise<StepExecution>;

  /** Record a terminal status for a step execution. */
  finishStep(stepExecutionId: number, input: FinishStepInput): Promise<void>;

  /**
   * All step executions of an execution, in **execution (start) order** —
   * ascending by creation, NOT by `seqNo`. Branches may run steps out of `seqNo`
   * order, and restart replay depends on this temporal order.
   */
  findStepExecutions(executionId: number): Promise<readonly StepExecution[]>;

  /**
   * Persist (upsert) an ExecutionContext snapshot for a job or step. `ctx` must
   * be JSON-serializable; implementations normalize through JSON.
   */
  saveContext(
    ownerType: ContextOwnerType,
    ownerId: number,
    ctx: Record<string, unknown>,
  ): Promise<void>;

  /** Load a previously saved ExecutionContext, or `null` if none. */
  loadContext(
    ownerType: ContextOwnerType,
    ownerId: number,
  ): Promise<Record<string, unknown> | null>;
}
