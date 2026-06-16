import { runJob } from '@stepflow/core';
import type { Job, JobParameters, JobRepository, Logger, RunJobResult } from '@stepflow/core';
import type { Browser } from 'puppeteer';

import { createPagePool } from './page-pool';
import type { PagePool } from './page-pool';

/** Options for {@link runJobsParallel}. */
export interface RunJobsParallelOptions {
  /** Metadata store, shared by all concurrent runs. */
  readonly repository: JobRepository;
  /** Maximum number of jobs running at once (the page-pool size). Must be >= 1. */
  readonly concurrency: number;
  /**
   * Launch (or connect to) the browser. Defaults to a lazy `puppeteer.launch()`.
   * Inject to control launch args or to supply a test double.
   */
  readonly launch?: () => Promise<Browser>;
  /**
   * Per-job deadline in milliseconds. On expiry the job's {@link RunJobOptions.signal}
   * is aborted (cooperative — a step should forward it to Puppeteer) AND its page
   * context is force-closed (unblocks page-bound waits). The job is then resolved as
   * a synthesized `FAILED` result via a deadline race, so even a step that ignores
   * the signal and blocks on non-page work can never hang the batch. The underlying
   * `runJob` may keep running in the background until its page work rejects; it
   * remains restartable. Omit for no timeout (an uncooperative step can then hang).
   */
  readonly jobTimeoutMs?: number;
  /** Logger passed to each run. Defaults to the engine's no-op. */
  readonly logger?: Logger;
}

async function defaultLaunch(): Promise<Browser> {
  // Lazy dynamic import so consumers who inject `launch` never load puppeteer,
  // and the peer dependency is only required when actually launching.
  const mod = await import('puppeteer');
  return mod.default.launch();
}

/** A synthesized `FAILED` result for failures with no (or an abandoned) execution. */
function failedResult(error: unknown): RunJobResult {
  return {
    instanceId: -1,
    executionId: -1,
    status: 'FAILED',
    exitStatus: 'FAILED',
    restarted: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

async function runOne(
  job: Job,
  params: JobParameters,
  pool: PagePool,
  options: RunJobsParallelOptions,
): Promise<RunJobResult> {
  const lease = await pool.acquire();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Isolate infra/repository rejections (runJob throws OUTSIDE the step try/catch,
  // e.g. createExecution fails) into a FAILED result, so one job's failure never
  // aborts the batch. The .catch also keeps this promise from rejecting unhandled
  // if the deadline race resolves first and this settles later.
  const run = runJob(job, {
    page: lease.page,
    browser: lease.browser,
    repository: options.repository,
    params,
    signal: controller.signal,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  }).catch((error: unknown): RunJobResult => failedResult(error));

  try {
    const timeoutMs = options.jobTimeoutMs;
    if (timeoutMs === undefined) {
      return await run;
    }
    // Hard backstop: abort the signal + force-close the context, but also resolve
    // the race ourselves so a step that ignores both never hangs the batch.
    const deadline = new Promise<RunJobResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        void lease.close();
        resolve(failedResult(new Error(`job timed out after ${String(timeoutMs)}ms`)));
      }, timeoutMs);
    });
    return await Promise.race([run, deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    await lease.close(); // idempotent — no-op if the timeout already closed it
  }
}

/**
 * Run one job across many parameter sets concurrently, bounded by `concurrency`.
 *
 * Each run gets an isolated {@link PageLease} (a fresh BrowserContext+Page). Runs
 * are fully independent: a step failure OR an infra/repository rejection yields a
 * `FAILED` result for that job only and never aborts the others. The browser pool
 * is created here and always drained on completion.
 *
 * Results are returned in the same order as `paramsList`.
 */
export async function runJobsParallel(
  job: Job,
  paramsList: readonly JobParameters[],
  options: RunJobsParallelOptions,
): Promise<RunJobResult[]> {
  const pool = createPagePool({
    launch: options.launch ?? defaultLaunch,
    concurrency: options.concurrency,
  });
  try {
    return await Promise.all(paramsList.map((params) => runOne(job, params, pool, options)));
  } finally {
    await pool.drain();
  }
}
