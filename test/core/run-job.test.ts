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

describe('runJob — linear flow', () => {
  it('runs steps in order and completes', async () => {
    const job = defineJob('linear')
      .step('a', async () => {
        log.push('a');
      })
      .step('b', async () => {
        log.push('b');
      })
      .step('c', async () => {
        log.push('c');
      })
      .build();

    const result = await runJob(job, { page, repository: repo });

    expect(log).toEqual(['a', 'b', 'c']);
    expect(result.status).toBe('COMPLETED');
    expect(result.exitStatus).toBe('COMPLETED');
    expect(result.restarted).toBe(false);
    expect(result.instanceId).toBeGreaterThan(0);

    const last = await repo.findLastExecution(result.instanceId);
    expect(last?.status).toBe('COMPLETED');
    const steps = await repo.findStepExecutions(result.executionId);
    expect(steps.map((s) => s.stepName)).toEqual(['a', 'b', 'c']);
    expect(steps.every((s) => s.status === 'COMPLETED')).toBe(true);
  });

  it('injects params into ctx.params', async () => {
    let seen = '';
    const job = defineJob('p')
      .step('a', async (ctx) => {
        seen = ctx.params.date ?? '';
      })
      .build();

    await runJob(job, { page, repository: repo, params: { date: '2026-06-13' } });

    expect(seen).toBe('2026-06-13');
  });

  it('shares mutable state between steps via ctx.shared and persists it as JOB context', async () => {
    const job = defineJob('s')
      .step('a', async (ctx) => {
        ctx.shared.x = 1;
      })
      .step('b', async (ctx) => {
        ctx.shared.y = (ctx.shared.x as number) + 1;
      })
      .build();

    const result = await runJob(job, { page, repository: repo });

    expect(await repo.loadContext('JOB', result.executionId)).toEqual({ x: 1, y: 2 });
  });
});

describe('runJob — exit status and branching', () => {
  it('ends COMPLETED with the terminal exit status when no transition matches', async () => {
    const job = defineJob('e')
      .step('parse', async () => 'EMPTY')
      .step('confirm', async () => {
        log.push('confirm');
      })
      .build();

    const result = await runJob(job, { page, repository: repo });

    expect(log).toEqual([]);
    expect(result.status).toBe('COMPLETED');
    expect(result.exitStatus).toBe('EMPTY');
  });

  it('branches on a custom exit status', async () => {
    const job = defineJob('b')
      .step('parse', async () => 'EMPTY')
      .step('confirm', async () => {
        log.push('confirm');
      })
      .step('cleanup', async () => {
        log.push('cleanup');
      })
      .branch('parse', { EMPTY: 'cleanup' })
      .build();

    const result = await runJob(job, { page, repository: repo });

    expect(log).toEqual(['cleanup']);
    expect(result.status).toBe('COMPLETED');
  });
});

describe('runJob — failure', () => {
  it('returns FAILED and records the failed step when a step throws without recovery', async () => {
    const job = defineJob('f')
      .step('a', async () => {
        log.push('a');
      })
      .step('b', async () => {
        throw new Error('boom');
      })
      .step('c', async () => {
        log.push('c');
      })
      .build();

    const result = await runJob(job, { page, repository: repo });

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('boom');
    expect(log).toEqual(['a']);

    const steps = await repo.findStepExecutions(result.executionId);
    expect(steps.find((s) => s.stepName === 'b')?.status).toBe('FAILED');
    expect(steps.find((s) => s.stepName === 'b')?.error).toContain('boom');
    expect((await repo.findLastExecution(result.instanceId))?.status).toBe('FAILED');
  });

  it('follows a FAILED branch to recover and complete', async () => {
    const job = defineJob('r')
      .step('collect', async () => {
        log.push('collect');
        throw new Error('flaky');
      })
      .step('notify', async () => {
        log.push('notify');
      })
      .step('cleanup', async () => {
        log.push('cleanup');
      })
      .branch('collect', { FAILED: 'cleanup' })
      .build();

    const result = await runJob(job, { page, repository: repo });

    expect(log).toEqual(['collect', 'cleanup']);
    expect(result.status).toBe('COMPLETED');
    const steps = await repo.findStepExecutions(result.executionId);
    expect(steps.find((s) => s.stepName === 'collect')?.status).toBe('FAILED');
  });
});

describe('runJob — restart', () => {
  function restartableJob(attempts: { process: number }) {
    return defineJob('restartable')
      .step('login', async () => {
        log.push('login');
      })
      .step('search', async (ctx) => {
        log.push('search');
        ctx.shared.rows = 5;
      })
      .step('process', async (ctx) => {
        log.push('process');
        attempts.process += 1;
        if (attempts.process === 1) throw new Error('flaky');
        log.push(`process-rows=${String(ctx.shared.rows)}`);
      })
      .build();
  }

  it('skips completed steps, restores shared, and resumes at the failed step', async () => {
    const attempts = { process: 0 };
    const job = restartableJob(attempts);

    const first = await runJob(job, { page, repository: repo });
    expect(first.status).toBe('FAILED');
    expect(first.restarted).toBe(false);
    expect(log).toEqual(['login', 'search', 'process']);

    log.length = 0;
    const second = await runJob(job, { page, repository: repo });

    expect(second.restarted).toBe(true);
    expect(second.status).toBe('COMPLETED');
    // login & search are NOT re-run; process re-runs and sees the restored rows.
    expect(log).toEqual(['process', 'process-rows=5']);

    // The restarted execution records the full path (carried prefix + resumed step).
    const steps = await repo.findStepExecutions(second.executionId);
    expect(steps.map((s) => s.stepName)).toEqual(['login', 'search', 'process']);
    expect(steps.every((s) => s.status === 'COMPLETED')).toBe(true);
  });

  it('runs fresh (not restart) when the last execution completed', async () => {
    const job = defineJob('fresh')
      .step('a', async () => {
        log.push('a');
      })
      .build();

    await runJob(job, { page, repository: repo });
    log.length = 0;
    const second = await runJob(job, { page, repository: repo });

    expect(second.restarted).toBe(false);
    expect(log).toEqual(['a']);
  });

  it('forces a fresh run with restart:false even after a failure', async () => {
    const attempts = { process: 0 };
    const job = restartableJob(attempts);

    await runJob(job, { page, repository: repo });
    log.length = 0;
    const second = await runJob(job, { page, repository: repo, restart: false });

    expect(second.restarted).toBe(false);
    // 'login' and 'search' re-run because restart is disabled.
    expect(log).toEqual(['login', 'search', 'process', 'process-rows=5']);
    expect(second.status).toBe('COMPLETED');
  });

  it('separates instances by identifying params (restart does not cross params)', async () => {
    const attempts = { process: 0 };
    const job = restartableJob(attempts);

    const a = await runJob(job, { page, repository: repo, params: { store: 'A' } });
    expect(a.status).toBe('FAILED');

    log.length = 0;
    // Different params -> different instance -> fresh run (process attempt #2 succeeds).
    const b = await runJob(job, { page, repository: repo, params: { store: 'B' } });
    expect(b.restarted).toBe(false);
    expect(b.instanceId).not.toBe(a.instanceId);
    expect(log).toEqual(['login', 'search', 'process', 'process-rows=5']);
  });
});
