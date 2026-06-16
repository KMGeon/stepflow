/** Backoff schedule between retry attempts of a step. */
export interface BackoffPolicy {
  /** Base delay before the first retry, in milliseconds. */
  readonly delayMs: number;
  /** Multiplier applied per subsequent retry (exponential). Defaults to `1` (fixed delay). */
  readonly multiplier?: number;
  /** Upper bound on the computed delay, in milliseconds. */
  readonly maxDelayMs?: number;
}

/**
 * Per-step retry policy. Attached via `defineJob().retry(stepName, policy)`.
 *
 * Only thrown errors are retried — an explicit `FAILED` exit-status return is an
 * intended terminal outcome and is never retried. `retryOn` further filters
 * which thrown errors are retryable.
 */
export interface RetryPolicy {
  /** Total attempts including the first run (so `3` means up to 2 retries). */
  readonly maxAttempts: number;
  /** Delay between attempts. Omitted means retry immediately. */
  readonly backoff?: BackoffPolicy;
  /** Predicate deciding whether a thrown error is retryable. Defaults to retrying every throw. */
  readonly retryOn?: (error: unknown) => boolean;
}

/** Payload for {@link JobListener.onRetry}, emitted after each failed-but-retryable attempt. */
export interface RetryInfo {
  readonly stepName: string;
  /** The attempt that just failed (1-based). */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Message of the error that triggered the retry. */
  readonly error: string;
  /** Delay before the next attempt, in milliseconds (`0` when there is no backoff). */
  readonly nextDelayMs: number;
}

/**
 * Compute the backoff delay (ms) to wait before the retry that follows a given
 * 1-based `attempt`. Exponential when `multiplier > 1`, capped by `maxDelayMs`.
 */
export function backoffDelay(backoff: BackoffPolicy | undefined, attempt: number): number {
  if (backoff === undefined) {
    return 0;
  }
  const multiplier = backoff.multiplier ?? 1;
  const raw = backoff.delayMs * multiplier ** (attempt - 1);
  return backoff.maxDelayMs !== undefined ? Math.min(raw, backoff.maxDelayMs) : raw;
}
