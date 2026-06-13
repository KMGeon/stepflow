import type { Browser, Page } from 'puppeteer';

import type { FinishStepInput, JobRepository } from './job-repository';
import type { StepExecution } from './metadata';
import type { Job } from './define-job';
import { computeJobKey } from './job-key';
import { COMPLETED, FAILED } from './types';
import type { BatchStatus, ExitStatus, JobParameters, Logger, StepContext } from './types';

/** Inputs for a single {@link runJob} call. */
export interface RunJobOptions {
  /** Injected Puppeteer Page. stepflow never launches a browser. */
  readonly page: Page;
  /** Metadata store. */
  readonly repository: JobRepository;
  /** Injected Puppeteer Browser, exposed to steps that open extra tabs. */
  readonly browser?: Browser;
  /** Job parameters; identifying params form the instance identity. Defaults to `{}`. */
  readonly params?: JobParameters;
  /** Logger; defaults to a no-op. */
  readonly logger?: Logger;
  /** When the last execution failed, resume from it. Defaults to `true`. */
  readonly restart?: boolean;
}

/** Outcome of a {@link runJob} call. */
export interface RunJobResult {
  readonly instanceId: number;
  readonly executionId: number;
  readonly status: TerminalStatus;
  readonly exitStatus: ExitStatus;
  /** Whether this run resumed a previously failed execution. */
  readonly restarted: boolean;
  /** Failure message, present only when `status` is `'FAILED'`. */
  readonly error?: string;
}

type TerminalStatus = Extract<BatchStatus, 'COMPLETED' | 'FAILED'>;

const noop = (): void => undefined;
const noopLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };

/**
 * Execute a job on an injected page, persisting all metadata and resuming a
 * previously failed run of the same instance when appropriate.
 *
 * Never throws for in-flow step failures: the outcome is reported via
 * {@link RunJobResult.status} (Spring Batch `JobLauncher` semantics).
 *
 * A step "fails" when it throws or explicitly returns the `FAILED` exit status;
 * either way the failure is recorded consistently and drives restart.
 */
export async function runJob(job: Job, options: RunJobOptions): Promise<RunJobResult> {
  const { page, repository, browser } = options;
  const logger = options.logger ?? noopLogger;
  const params: JobParameters = options.params ?? {};
  const allowRestart = options.restart !== false;

  const jobKey = computeJobKey(job.name, params);
  const instance = await repository.resolveInstance(job.name, jobKey);
  const previous = await repository.findLastExecution(instance.id);
  const restarting = allowRestart && previous !== null && previous.status === FAILED;

  const execution = await repository.createExecution(instance.id, params);

  const shared: Record<string, unknown> =
    restarting && previous !== null
      ? ((await repository.loadContext('JOB', previous.id)) ?? {})
      : {};

  let current: string | null = job.entry;
  if (restarting && previous !== null) {
    const priorSteps = await repository.findStepExecutions(previous.id);
    current = await carryForwardPrefix(job, repository, execution.id, priorSteps);
  }

  const ctx = buildContext({
    jobName: job.name,
    instanceId: instance.id,
    executionId: execution.id,
    params,
    page,
    shared,
    logger,
    browser,
  });

  let lastExitStatus: ExitStatus = COMPLETED;
  let failure: string | null = null;

  while (current !== null) {
    const { step, seqNo } = job.stepAt(current);
    const stepExecution = await repository.startStep(execution.id, step.name, seqNo);

    const startedAt = Date.now();
    let exitStatus: ExitStatus;
    let threw = false;
    let errorMessage: string | undefined;
    try {
      const returned = await step.run(ctx);
      exitStatus = typeof returned === 'string' ? returned : COMPLETED;
    } catch (error) {
      threw = true;
      exitStatus = FAILED;
      errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`step "${step.name}" failed`, { jobName: job.name, error: errorMessage });
    }
    const durationMs = Date.now() - startedAt;
    // A step fails if it threw OR explicitly returned FAILED, so the persisted
    // step status and the restart resume point stay consistent.
    const failed = threw || exitStatus === FAILED;

    await repository.finishStep(
      stepExecution.id,
      finishStepInput(failed, exitStatus, durationMs, errorMessage),
    );

    lastExitStatus = exitStatus;
    const next = job.next(step.name, exitStatus);
    const terminalFailure = failed && next === null;

    // Checkpoint `shared` only on a non-failing boundary: a terminal failed
    // step's partial writes must not be re-seeded (and re-applied) on restart.
    if (!terminalFailure) {
      await repository.saveContext('JOB', execution.id, shared);
    }

    if (next === null) {
      if (failed) {
        failure = errorMessage ?? `step "${step.name}" ended with exit status "${exitStatus}"`;
      }
      current = null;
    } else {
      current = next;
    }
  }

  const status: TerminalStatus = failure !== null ? FAILED : COMPLETED;
  await repository.finishExecution(execution.id, {
    status,
    exitStatus: lastExitStatus,
    ...(failure !== null ? { error: failure } : {}),
  });

  return {
    instanceId: instance.id,
    executionId: execution.id,
    status,
    exitStatus: lastExitStatus,
    restarted: restarting,
    ...(failure !== null ? { error: failure } : {}),
  };
}

/**
 * Re-record the completed prefix of a failed run into the new execution and
 * return the name of the step to resume at — the step that actually terminated
 * the prior run (its last, failed step) — or `null`-safe fallback to the entry
 * when the prior run cannot be resumed.
 */
async function carryForwardPrefix(
  job: Job,
  repository: JobRepository,
  executionId: number,
  priorSteps: readonly StepExecution[],
): Promise<string | null> {
  const terminal = priorSteps[priorSteps.length - 1];
  // A failed run always terminates on a failed step; if the prior run is empty
  // or did not end on a failure, there is nothing to resume — start fresh.
  if (terminal?.status !== FAILED) {
    return job.entry;
  }
  for (const prior of priorSteps.slice(0, priorSteps.length - 1)) {
    const { seqNo } = job.stepAt(prior.stepName);
    const carried = await repository.startStep(executionId, prior.stepName, seqNo);
    await repository.finishStep(carried.id, {
      status: prior.status === FAILED ? FAILED : COMPLETED,
      exitStatus: prior.exitStatus ?? COMPLETED,
    });
  }
  return terminal.stepName;
}

function finishStepInput(
  failed: boolean,
  exitStatus: ExitStatus,
  durationMs: number,
  errorMessage: string | undefined,
): FinishStepInput {
  return {
    status: failed ? FAILED : COMPLETED,
    exitStatus,
    durationMs,
    ...(errorMessage !== undefined ? { error: errorMessage } : {}),
  };
}

function buildContext(parts: {
  jobName: string;
  instanceId: number;
  executionId: number;
  params: JobParameters;
  page: Page;
  shared: Record<string, unknown>;
  logger: Logger;
  browser: Browser | undefined;
}): StepContext {
  const base = {
    jobName: parts.jobName,
    instanceId: parts.instanceId,
    executionId: parts.executionId,
    params: parts.params,
    page: parts.page,
    shared: parts.shared,
    logger: parts.logger,
  };
  return parts.browser !== undefined ? { ...base, browser: parts.browser } : base;
}
