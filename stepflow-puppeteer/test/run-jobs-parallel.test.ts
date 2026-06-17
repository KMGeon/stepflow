import { defineJob, InMemoryJobRepository } from '@kmgeon/stepflow-core';
import type { JobExecution, JobParameters } from '@kmgeon/stepflow-core';
import { describe, expect, it } from 'vitest';

import { runJobsParallel } from '../src/run-jobs-parallel';
import { createFakeBrowser } from './fake-browser';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A repository whose createExecution rejects for one params set (simulated infra error). */
class FlakyRepo extends InMemoryJobRepository {
  override createExecution(instanceId: number, params: JobParameters): Promise<JobExecution> {
    if (params.id === '1') {
      return Promise.reject(new Error('DB down'));
    }
    return super.createExecution(instanceId, params);
  }
}

describe('runJobsParallel', () => {
  it('runs every param set, one context per job, drains at the end', async () => {
    const fb = createFakeBrowser();
    const seen: string[] = [];
    const job = defineJob('p')
      .step('a', async (ctx) => {
        seen.push(ctx.params.id ?? '?');
      })
      .build();

    const results = await runJobsParallel(job, [{ id: '1' }, { id: '2' }, { id: '3' }], {
      repository: new InMemoryJobRepository(),
      concurrency: 2,
      launch: () => Promise.resolve(fb.browser),
    });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'COMPLETED')).toBe(true);
    expect([...seen].sort()).toEqual(['1', '2', '3']);
    expect(fb.contextsOpened()).toBe(3); // one isolated context per job
    expect(fb.contextsClosed()).toBe(3); // each freed
    expect(fb.browserClosed()).toBe(true); // pool drained
  });

  it('never exceeds the concurrency cap, yet runs in parallel', async () => {
    const fb = createFakeBrowser();
    let active = 0;
    let maxActive = 0;
    const job = defineJob('p')
      .step('a', async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await tick();
        await tick();
        active -= 1;
      })
      .build();
    const params = Array.from({ length: 6 }, (_, i) => ({ id: String(i) }));

    await runJobsParallel(job, params, {
      repository: new InMemoryJobRepository(),
      concurrency: 2,
      launch: () => Promise.resolve(fb.browser),
    });

    expect(maxActive).toBeLessThanOrEqual(2); // cap respected
    expect(maxActive).toBe(2); // proves genuine parallelism
  });

  it('isolates failures: one failing job does not abort the others', async () => {
    const fb = createFakeBrowser();
    const job = defineJob('p')
      .step('a', (ctx) => {
        if (ctx.params.id === '1') {
          return Promise.reject(new Error('boom'));
        }
        return Promise.resolve();
      })
      .build();

    const results = await runJobsParallel(job, [{ id: '0' }, { id: '1' }, { id: '2' }], {
      repository: new InMemoryJobRepository(),
      concurrency: 3,
      launch: () => Promise.resolve(fb.browser),
    });

    expect(results.map((r) => r.status)).toEqual(['COMPLETED', 'FAILED', 'COMPLETED']);
  });

  it('times out a hung job: aborts the signal, force-closes the context, returns FAILED', async () => {
    const fb = createFakeBrowser();
    const job = defineJob('p')
      .step('a', (ctx) => {
        // A step that only ends when the deadline aborts its signal.
        return new Promise<void>((_, reject) => {
          ctx.signal?.addEventListener('abort', () => {
            reject(new Error('timed out'));
          });
        });
      })
      .build();

    const results = await runJobsParallel(job, [{ id: '0' }], {
      repository: new InMemoryJobRepository(),
      concurrency: 1,
      jobTimeoutMs: 20,
      launch: () => Promise.resolve(fb.browser),
    });

    expect(results[0]?.status).toBe('FAILED');
    expect(fb.contextsClosed()).toBe(1); // force-close + finally close == one (idempotent)
  });

  it('isolates an infra/repository rejection: the batch resolves with siblings intact', async () => {
    const fb = createFakeBrowser();
    const job = defineJob('p')
      .step('a', async () => undefined)
      .build();

    const results = await runJobsParallel(job, [{ id: '0' }, { id: '1' }, { id: '2' }], {
      repository: new FlakyRepo(),
      concurrency: 3,
      launch: () => Promise.resolve(fb.browser),
    });

    expect(results.map((r) => r.status)).toEqual(['COMPLETED', 'FAILED', 'COMPLETED']);
    expect(results[1]?.error).toMatch(/DB down/);
    expect(fb.browserClosed()).toBe(true); // still drained
  });

  it('does not hang when a step ignores the signal: the deadline still resolves FAILED', async () => {
    const fb = createFakeBrowser();
    const job = defineJob('p')
      // A step that never settles and ignores ctx.signal — only the deadline race saves us.
      .step('a', () => new Promise<void>(() => undefined))
      .build();

    const results = await runJobsParallel(job, [{ id: '0' }], {
      repository: new InMemoryJobRepository(),
      concurrency: 1,
      jobTimeoutMs: 20,
      launch: () => Promise.resolve(fb.browser),
    });

    expect(results[0]?.status).toBe('FAILED');
    expect(results[0]?.error).toMatch(/timed out/);
    expect(fb.browserClosed()).toBe(true); // drained — proves the batch did not hang
  });
});
