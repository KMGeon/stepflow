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
