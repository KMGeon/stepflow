import type { BatchStatus, ExitStatus, JobParameters } from '../types';
import type { FinishExecutionInput, FinishStepInput, JobRepository } from './job-repository';
import type {
  ContextOwnerType,
  JobExecution,
  JobInstance,
  StepCounts,
  StepExecution,
} from '../metadata/metadata';

interface ExecutionRecord {
  id: number;
  instanceId: number;
  status: BatchStatus;
  exitStatus: ExitStatus | null;
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number | null;
  error: string | null;
  itemsCollected: number | null;
  resultMeta: Record<string, unknown> | null;
}

interface StepRecord {
  id: number;
  jobExecutionId: number;
  stepName: string;
  seqNo: number;
  status: BatchStatus;
  exitStatus: ExitStatus | null;
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number | null;
  counts: StepCounts;
  error: string | null;
}

const ZERO_COUNTS: StepCounts = { readCount: 0, writeCount: 0, skipCount: 0 };

/**
 * In-memory {@link JobRepository} for tests and local runs. Holds no external
 * resources; round-trips ExecutionContext and result metadata through JSON (like
 * the MySQL adapter) so stored state never aliases caller state and the two
 * implementations are behaviourally identical.
 */
export class InMemoryJobRepository implements JobRepository {
  #instanceSeq = 0;
  #executionSeq = 0;
  #stepSeq = 0;

  readonly #instancesByKey = new Map<string, JobInstance>();
  readonly #executions = new Map<number, ExecutionRecord>();
  readonly #executionIdsByInstance = new Map<number, number[]>();
  readonly #stepsByExecution = new Map<number, StepRecord[]>();
  readonly #stepsById = new Map<number, StepRecord>();
  readonly #contexts = new Map<string, Record<string, unknown>>();

  resolveInstance(jobName: string, jobKey: string): Promise<JobInstance> {
    const mapKey = compositeKey(jobName, jobKey);
    const existing = this.#instancesByKey.get(mapKey);
    if (existing !== undefined) {
      return Promise.resolve({ ...existing });
    }
    const instance: JobInstance = { id: ++this.#instanceSeq, jobName, jobKey };
    this.#instancesByKey.set(mapKey, instance);
    return Promise.resolve({ ...instance });
  }

  findLastExecution(instanceId: number): Promise<JobExecution | null> {
    const ids = this.#executionIdsByInstance.get(instanceId);
    const lastId = ids?.at(-1);
    if (lastId === undefined) {
      return Promise.resolve(null);
    }
    const record = this.#executions.get(lastId);
    return Promise.resolve(record ? snapshotExecution(record) : null);
  }

  createExecution(instanceId: number, _params: JobParameters): Promise<JobExecution> {
    const record: ExecutionRecord = {
      id: ++this.#executionSeq,
      instanceId,
      status: 'STARTED',
      exitStatus: null,
      startedAt: new Date(),
      endedAt: null,
      durationMs: null,
      error: null,
      itemsCollected: null,
      resultMeta: null,
    };
    this.#executions.set(record.id, record);
    const ids = this.#executionIdsByInstance.get(instanceId) ?? [];
    ids.push(record.id);
    this.#executionIdsByInstance.set(instanceId, ids);
    return Promise.resolve(snapshotExecution(record));
  }

  finishExecution(executionId: number, input: FinishExecutionInput): Promise<void> {
    const record = this.#executions.get(executionId);
    if (record === undefined) {
      throw new Error(`InMemoryJobRepository: unknown execution ${String(executionId)}`);
    }
    const endedAt = new Date();
    record.status = input.status;
    record.exitStatus = input.exitStatus;
    record.endedAt = endedAt;
    record.durationMs = endedAt.getTime() - record.startedAt.getTime();
    record.error = input.error ?? null;
    record.itemsCollected = input.itemsCollected ?? null;
    record.resultMeta = input.resultMeta ? jsonClone(input.resultMeta) : null;
    return Promise.resolve();
  }

  startStep(executionId: number, stepName: string, seqNo: number): Promise<StepExecution> {
    const record: StepRecord = {
      id: ++this.#stepSeq,
      jobExecutionId: executionId,
      stepName,
      seqNo,
      status: 'STARTED',
      exitStatus: null,
      startedAt: new Date(),
      endedAt: null,
      durationMs: null,
      counts: { ...ZERO_COUNTS },
      error: null,
    };
    const steps = this.#stepsByExecution.get(executionId) ?? [];
    steps.push(record);
    this.#stepsByExecution.set(executionId, steps);
    this.#stepsById.set(record.id, record);
    return Promise.resolve(snapshotStep(record));
  }

  finishStep(stepExecutionId: number, input: FinishStepInput): Promise<void> {
    const record = this.#stepsById.get(stepExecutionId);
    if (record === undefined) {
      throw new Error(`InMemoryJobRepository: unknown step execution ${String(stepExecutionId)}`);
    }
    const endedAt = new Date();
    record.status = input.status;
    record.exitStatus = input.exitStatus;
    record.endedAt = endedAt;
    record.durationMs = input.durationMs ?? endedAt.getTime() - record.startedAt.getTime();
    record.error = input.error ?? null;
    record.counts = {
      readCount: input.counts?.readCount ?? record.counts.readCount,
      writeCount: input.counts?.writeCount ?? record.counts.writeCount,
      skipCount: input.counts?.skipCount ?? record.counts.skipCount,
    };
    return Promise.resolve();
  }

  findStepExecutions(executionId: number): Promise<readonly StepExecution[]> {
    const steps = this.#stepsByExecution.get(executionId) ?? [];
    // Execution (start) order, not definition order — branches can run steps
    // out of seqNo order, and restart replay depends on the temporal sequence.
    const ordered = [...steps].sort((a, b) => a.id - b.id).map(snapshotStep);
    return Promise.resolve(ordered);
  }

  saveContext(
    ownerType: ContextOwnerType,
    ownerId: number,
    ctx: Record<string, unknown>,
  ): Promise<void> {
    this.#contexts.set(contextKey(ownerType, ownerId), jsonClone(ctx));
    return Promise.resolve();
  }

  loadContext(
    ownerType: ContextOwnerType,
    ownerId: number,
  ): Promise<Record<string, unknown> | null> {
    const found = this.#contexts.get(contextKey(ownerType, ownerId));
    return Promise.resolve(found ? jsonClone(found) : null);
  }
}

function compositeKey(jobName: string, jobKey: string): string {
  return JSON.stringify([jobName, jobKey]);
}

function contextKey(ownerType: ContextOwnerType, ownerId: number): string {
  return JSON.stringify([ownerType, ownerId]);
}

/**
 * Round-trip through JSON so stored state neither aliases caller state nor
 * preserves non-JSON values — matching the JSON-column semantics of
 * MySqlJobRepository, so both implementations behave identically.
 */
function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function snapshotExecution(record: ExecutionRecord): JobExecution {
  return {
    id: record.id,
    instanceId: record.instanceId,
    status: record.status,
    exitStatus: record.exitStatus,
    startedAt: new Date(record.startedAt),
    endedAt: record.endedAt ? new Date(record.endedAt) : null,
    durationMs: record.durationMs,
    error: record.error,
    itemsCollected: record.itemsCollected,
    resultMeta: record.resultMeta ? jsonClone(record.resultMeta) : null,
  };
}

function snapshotStep(record: StepRecord): StepExecution {
  return {
    id: record.id,
    jobExecutionId: record.jobExecutionId,
    stepName: record.stepName,
    seqNo: record.seqNo,
    status: record.status,
    exitStatus: record.exitStatus,
    startedAt: new Date(record.startedAt),
    endedAt: record.endedAt ? new Date(record.endedAt) : null,
    durationMs: record.durationMs,
    counts: { ...record.counts },
    error: record.error,
  };
}
