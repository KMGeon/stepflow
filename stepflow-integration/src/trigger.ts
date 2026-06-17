import type { RunJobResult } from '@kmgeon/stepflow-core';

/** Handle returned by {@link JobTrigger.start} to stop further firing. */
export interface TriggerHandle {
  /** Stop the trigger; no further runs are fired after this resolves. */
  stop(): Promise<void>;
}

/**
 * A source that decides WHEN a job runs (cron schedule, queue message, webhook,
 * fixed interval). A trigger does not know HOW to run the job: the caller supplies
 * a `run` thunk (typically a closure over `runJob` from `@kmgeon/stepflow-core`).
 *
 * Reference implementations: {@link createManualTrigger} (manual) and
 * {@link intervalTrigger} (fixed interval). Concrete cron/queue adapters land in
 * later releases.
 */
export interface JobTrigger {
  /**
   * Begin listening. Each time the trigger fires it invokes `run`. Returns a
   * {@link TriggerHandle} that stops further firing.
   */
  start(run: () => Promise<RunJobResult>): Promise<TriggerHandle>;
}
