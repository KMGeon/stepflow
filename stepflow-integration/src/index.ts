import type { RunJobResult } from '@stepflow/core';

/** Handle returned by {@link JobTrigger.start} to stop further firing. */
export interface TriggerHandle {
  /** Stop the trigger; no further runs are fired after this resolves. */
  stop(): Promise<void>;
}

/**
 * A source that decides WHEN a job runs (cron schedule, queue message, webhook).
 *
 * A trigger does not know HOW to run the job: the caller supplies a `run` thunk
 * (typically a closure over `runJob` from `@stepflow/core`). Concrete adapters
 * (cron, SQS, BullMQ, ...) land in later releases; this package ships the seam
 * plus {@link createManualTrigger}, the manual reference implementation.
 */
export interface JobTrigger {
  /**
   * Begin listening. Each time the trigger fires it invokes `run`. Returns a
   * {@link TriggerHandle} that stops further firing.
   */
  start(run: () => Promise<RunJobResult>): Promise<TriggerHandle>;
}

/**
 * A {@link JobTrigger} whose firing is driven manually via {@link ManualTrigger.fire}.
 * Useful for tests and hand-operated runs, and the reference implementation of
 * the trigger seam.
 */
export interface ManualTrigger extends JobTrigger {
  /** Run the registered job once. Throws if {@link JobTrigger.start} has not run, or after stop. */
  fire(): Promise<RunJobResult>;
}

/** Build a {@link ManualTrigger}. */
export function createManualTrigger(): ManualTrigger {
  let runner: (() => Promise<RunJobResult>) | null = null;
  let activeToken: symbol | null = null;
  return {
    start(run: () => Promise<RunJobResult>): Promise<TriggerHandle> {
      const token = Symbol('manual-trigger');
      activeToken = token;
      runner = run;
      return Promise.resolve({
        stop(): Promise<void> {
          // Only clear if this handle still owns the active slot, so a stale
          // handle from an earlier start() cannot stop a newer run.
          if (activeToken === token) {
            activeToken = null;
            runner = null;
          }
          return Promise.resolve();
        },
      });
    },
    fire(): Promise<RunJobResult> {
      if (runner === null) {
        // Reject (not throw) so the async signature holds and `.catch()` works.
        return Promise.reject(
          new Error('ManualTrigger.fire() called before start() (or after stop())'),
        );
      }
      return runner();
    },
  };
}
