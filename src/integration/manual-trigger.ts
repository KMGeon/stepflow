import type { RunJobResult } from '@kmgeon/stepflow';

import type { JobTrigger, TriggerHandle } from './trigger';

/**
 * A {@link JobTrigger} whose firing is driven manually via {@link ManualTrigger.fire}.
 * Useful for tests and hand-operated runs, and the reference implementation of
 * the trigger seam.
 */
export interface ManualTrigger extends JobTrigger {
  /** Run the registered job once. Rejects if {@link JobTrigger.start} has not run, or after stop. */
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
