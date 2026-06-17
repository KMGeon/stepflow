import type { ExitStatus, StepContext, StepRun } from '../types';

/**
 * Thrown by the engine when a step exceeds its configured per-attempt timeout.
 * Surfaced as a normal thrown error so it flows through the existing retry budget
 * and is recorded as a FAILED step.
 */
export class StepTimeoutError extends Error {
  readonly stepName: string;
  readonly timeoutMs: number;
  constructor(stepName: string, timeoutMs: number) {
    super(`step "${stepName}" exceeded timeout of ${timeoutMs}ms`);
    this.name = 'StepTimeoutError';
    this.stepName = stepName;
    this.timeoutMs = timeoutMs;
  }
}

/** A pending timeout: `promise` resolves when the deadline elapses; `cancel` stops it. */
export interface TimeoutHandle {
  readonly promise: Promise<void>;
  cancel(): void;
}

/** Schedules a deadline. Injectable so tests need not wait real time. */
export type TimeoutScheduler = (ms: number) => TimeoutHandle;

/** Default scheduler backed by `setTimeout`. */
export const realTimeout: TimeoutScheduler = (ms) => {
  let id: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    id = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      if (id !== undefined) clearTimeout(id);
    },
  };
};

/**
 * Run a step under a per-attempt deadline. Races the step against the scheduled
 * timeout; on timeout it aborts a child AbortSignal (linked to the caller's
 * signal) so the step can cancel cooperatively, then throws StepTimeoutError.
 * The engine never force-closes the page — that stays the caller's responsibility.
 */
export async function runWithTimeout(
  run: StepRun,
  ctx: StepContext,
  opts: {
    stepName: string;
    timeoutMs: number;
    scheduler: TimeoutScheduler;
    parentSignal?: AbortSignal;
  },
): Promise<void | ExitStatus> {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  if (opts.parentSignal !== undefined) {
    if (opts.parentSignal.aborted) controller.abort();
    else opts.parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const childCtx: StepContext = { ...ctx, signal: controller.signal };
  const timer = opts.scheduler(opts.timeoutMs);
  try {
    return await Promise.race([
      run(childCtx),
      timer.promise.then((): never => {
        throw new StepTimeoutError(opts.stepName, opts.timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof StepTimeoutError) controller.abort();
    throw error;
  } finally {
    timer.cancel();
    opts.parentSignal?.removeEventListener('abort', onParentAbort);
  }
}
