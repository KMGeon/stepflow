import type { Page } from 'puppeteer';
import { beforeEach, describe, expect, it } from 'vitest';

import { defineJob } from '../../src/core/define-job';
import { runJob } from '../../src/core/run-job';
import { InMemoryJobRepository } from '../../src/repository/in-memory';

const page = {} as unknown as Page;

let repo: InMemoryJobRepository;
let log: string[];

beforeEach(() => {
  repo = new InMemoryJobRepository();
  log = [];
});

describe('runJob — failure & restart edge cases', () => {
  it('treats a returned "FAILED" exit status as a real failure (status, error, restart point)', async () => {
    const attempts = { c: 0 };
    const job = defineJob('softfail')
      .step('a', async () => {
        log.push('a');
      })
      .step('b', async () => {
        log.push('b');
      })
      .step('c', async () => {
        log.push('c');
        attempts.c += 1;
        return attempts.c === 1 ? 'FAILED' : 'COMPLETED';
      })
      .build();

    const first = await runJob(job, { page, repository: repo });
    expect(first.status).toBe('FAILED');
    expect(first.error).toBeDefined();
    const steps1 = await repo.findStepExecutions(first.executionId);
    expect(steps1.find((s) => s.stepName === 'c')?.status).toBe('FAILED');

    log.length = 0;
    const second = await runJob(job, { page, repository: repo });
    expect(second.restarted).toBe(true);
    expect(second.status).toBe('COMPLETED');
    expect(log).toEqual(['c']); // a, b skipped; resume at the soft-failed step
  });

  it('resumes at the terminal failure, not an earlier recovered failure', async () => {
    const attempts = { c: 0 };
    const job = defineJob('recover-then-fail')
      .step('a', async () => {
        log.push('a');
        throw new Error('a-flaky');
      })
      .step('b', async () => {
        log.push('b');
      })
      .step('c', async () => {
        log.push('c');
        attempts.c += 1;
        if (attempts.c === 1) throw new Error('c-flaky');
      })
      .branch('a', { FAILED: 'b' }) // a recovers to b
      .build();

    const first = await runJob(job, { page, repository: repo });
    expect(first.status).toBe('FAILED');
    expect(log).toEqual(['a', 'b', 'c']);

    log.length = 0;
    const second = await runJob(job, { page, repository: repo });
    expect(second.restarted).toBe(true);
    expect(second.status).toBe('COMPLETED');
    // a (recovered) and b are skipped; resume only at the terminal failure c.
    expect(log).toEqual(['c']);
  });

  it("does not re-apply a failed step's partial shared mutations on restart", async () => {
    const attempts = { c: 0 };
    const job = defineJob('no-double-apply')
      .step('a', async (ctx) => {
        ctx.shared.base = 10;
      })
      .step('c', async (ctx) => {
        attempts.c += 1;
        ctx.shared.count = ((ctx.shared.count as number | undefined) ?? 0) + 1;
        if (attempts.c === 1) throw new Error('after-mutation');
      })
      .build();

    const first = await runJob(job, { page, repository: repo });
    expect(first.status).toBe('FAILED');

    const second = await runJob(job, { page, repository: repo });
    expect(second.status).toBe('COMPLETED');
    // count applied exactly once: the failed attempt's mutation was not persisted.
    expect(await repo.loadContext('JOB', second.executionId)).toEqual({ base: 10, count: 1 });
  });
});
