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
   * is aborted (cooperative) and its page context is force-closed (backstop), so a
   * hung step is unblocked and the slot reclaimed. The job is reported `FAILED` and
   * remains restartable. Omit for no timeout.
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

async function runOne(
  job: Job,
  params: JobParameters,
  pool: PagePool,
  options: RunJobsParallelOptions,
): Promise<RunJobResult> {
  const lease = await pool.acquire();
  const controller = new AbortController();
  const timer =
    options.jobTimeoutMs !== undefined
      ? setTimeout(() => {
          controller.abort();
          void lease.close(); // backstop: force-close unblocks a step that ignores the signal
        }, options.jobTimeoutMs)
      : undefined;
  try {
    return await runJob(job, {
      page: lease.page,
      browser: lease.browser,
      repository: options.repository,
      params,
      signal: controller.signal,
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    });
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
 * are independent: one failing does not abort the others (the engine reports
 * failures via {@link RunJobResult.status} rather than throwing). The browser pool
 * is created here and drained on completion.
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
