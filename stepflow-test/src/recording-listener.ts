import type { JobListener } from '@stepflow/core';

/** A {@link JobListener} that appends an ordered string tag for every call. */
export interface RecordingListener extends JobListener {
  /** Tags in the order the listener was invoked. */
  readonly events: readonly string[];
}

/**
 * Build a {@link JobListener} that records each lifecycle call as a tag in
 * `events`, for asserting emit order and payloads in tests.
 *
 * Tag formats: `beforeJob:<jobName>`, `afterJob:<status>`,
 * `beforeStep:<stepName>`, `afterStep:<stepName>:<status>`,
 * `onStepError:<stepName>:<errorMessage>`.
 */
export function createRecordingListener(): RecordingListener {
  const events: string[] = [];
  return {
    events,
    beforeJob: (ctx) => {
      events.push(`beforeJob:${ctx.jobName}`);
    },
    afterJob: (_ctx, result) => {
      events.push(`afterJob:${result.status}`);
    },
    beforeStep: (_ctx, step) => {
      events.push(`beforeStep:${step.stepName}`);
    },
    afterStep: (_ctx, step, outcome) => {
      events.push(`afterStep:${step.stepName}:${outcome.status}`);
    },
    onStepError: (_ctx, step, error) => {
      events.push(
        `onStepError:${step.stepName}:${error instanceof Error ? error.message : String(error)}`,
      );
    },
  };
}
