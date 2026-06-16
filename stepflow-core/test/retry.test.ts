import type { Page } from 'puppeteer';
import { beforeEach, describe, expect, it } from 'vitest';

import { defineJob } from '../src/builder/define-job';
import { runJob } from '../src/engine/run-job';
import { InMemoryJobRepository } from '../src/repository/in-memory';
import type { JobListener } from '../src/engine/listeners';
import type { RetryInfo } from '../src/engine/retry';
import { backoffDelay } from '../src/engine/retry';

const page = {} as unknown as Page;
const noDelay = (): Promise<void> => Promise.resolve();

let repo: InMemoryJobRepository;

beforeEach(() => {
  repo = new InMemoryJobRepository();
});

/** A step that throws on its first `failTimes` calls, then succeeds. */
function flakyStep(failTimes: number): { run: () => Promise<void>; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    run: () => {
      calls += 1;
      if (calls <= failTimes) {
        return Promise.reject(new Error(`fail-${String(calls)}`));
      }
      return Promise.resolve();
    },
  };
}

async function attemptsOf(executionId: number, stepName: string): Promise<number | undefined> {
  const steps = await repo.findStepExecutions(executionId);
  return steps.find((s) => s.stepName === stepName)?.attempts;
}

describe('backoffDelay', () => {
  it('returns 0 when there is no backoff', () => {
    expect(backoffDelay(undefined, 1)).toBe(0);
    expect(backoffDelay(undefined, 5)).toBe(0);
  });

  it('returns a fixed delay when multiplier is absent', () => {
    expect(backoffDelay({ delayMs: 100 }, 1)).toBe(100);
    expect(backoffDelay({ delayMs: 100 }, 4)).toBe(100);
  });

  it('grows exponentially with multiplier', () => {
    const b = { delayMs: 100, multiplier: 2 };
    expect(backoffDelay(b, 1)).toBe(100);
    expect(backoffDelay(b, 2)).toBe(200);
    expect(backoffDelay(b, 3)).toBe(400);
  });

  it('caps at maxDelayMs', () => {
    const b = { delayMs: 100, multiplier: 10, maxDelayMs: 500 };
    expect(backoffDelay(b, 1)).toBe(100);
    expect(backoffDelay(b, 2)).toBe(500);
    expect(backoffDelay(b, 3)).toBe(500);
  });
});

describe('runJob — retry', () => {
  it('does not retry a step without a policy (one attempt, then FAILED)', async () => {
    const flaky = flakyStep(1);
    const job = defineJob('r').step('a', flaky.run).build();

    const result = await runJob(job, { page, repository: repo, delay: noDelay });

    expect(result.status).toBe('FAILED');
    expect(flaky.calls()).toBe(1);
    expect(await attemptsOf(result.executionId, 'a')).toBe(1);
  });

  it('retries a thrown error up to maxAttempts and succeeds', async () => {
    const flaky = flakyStep(2);
    const job = defineJob('r').step('a', flaky.run).retry('a', { maxAttempts: 3 }).build();

    const result = await runJob(job, { page, repository: repo, delay: noDelay });

    expect(result.status).toBe('COMPLETED');
    expect(flaky.calls()).toBe(3);
    expect(await attemptsOf(result.executionId, 'a')).toBe(3);
  });

  it('fails after exhausting maxAttempts', async () => {
    const flaky = flakyStep(99);
    const job = defineJob('r').step('a', flaky.run).retry('a', { maxAttempts: 3 }).build();

    const result = await runJob(job, { page, repository: repo, delay: noDelay });

    expect(result.status).toBe('FAILED');
    expect(flaky.calls()).toBe(3);
    expect(await attemptsOf(result.executionId, 'a')).toBe(3);
  });

  it('does NOT retry an explicit FAILED return', async () => {
    let calls = 0;
    const job = defineJob('r')
      .step('a', () => {
        calls += 1;
        return Promise.resolve('FAILED');
      })
      .retry('a', { maxAttempts: 3 })
      .build();

    const result = await runJob(job, { page, repository: repo, delay: noDelay });

    expect(result.status).toBe('FAILED');
    expect(calls).toBe(1);
    expect(await attemptsOf(result.executionId, 'a')).toBe(1);
  });

  it('honors retryOn: only retries matching errors', async () => {
    let calls = 0;
    const job = defineJob('r')
      .step('a', () => {
        calls += 1;
        return Promise.reject(new Error('non-transient'));
      })
      .retry('a', {
        maxAttempts: 5,
        retryOn: (e) => e instanceof Error && e.message === 'transient',
      })
      .build();

    const result = await runJob(job, { page, repository: repo, delay: noDelay });

    expect(result.status).toBe('FAILED');
    expect(calls).toBe(1); // not retried because the predicate rejected it
  });

  it('emits onRetry per failed attempt with backoff delays, and waits via injected delay', async () => {
    const flaky = flakyStep(2);
    const retries: RetryInfo[] = [];
    const listener: JobListener = {
      onRetry: (_ctx, _step, info) => {
        retries.push(info);
      },
    };
    const delays: number[] = [];
    const job = defineJob('r')
      .step('a', flaky.run)
      .retry('a', { maxAttempts: 3, backoff: { delayMs: 10, multiplier: 2 } })
      .build();

    const result = await runJob(job, {
      page,
      repository: repo,
      listeners: [listener],
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    expect(result.status).toBe('COMPLETED');
    expect(retries.map((r) => r.attempt)).toEqual([1, 2]);
    expect(retries.map((r) => r.nextDelayMs)).toEqual([10, 20]);
    expect(retries[0]?.maxAttempts).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  it('isolates a throwing onRetry listener (job still completes)', async () => {
    const flaky = flakyStep(1);
    const listener: JobListener = {
      onRetry: () => {
        throw new Error('listener boom');
      },
    };
    const job = defineJob('r').step('a', flaky.run).retry('a', { maxAttempts: 3 }).build();

    const result = await runJob(job, {
      page,
      repository: repo,
      listeners: [listener],
      delay: noDelay,
    });

    expect(result.status).toBe('COMPLETED');
    expect(flaky.calls()).toBe(2);
  });

  it('gives a fresh retry budget on restart after exhausting retries', async () => {
    let calls = 0;
    const job = defineJob('r')
      .step('a', () => {
        calls += 1;
        // Fail the first 3 calls (run 1 exhausts maxAttempts=2 across calls 1-2),
        // then succeed on the restart.
        if (calls <= 2) {
          return Promise.reject(new Error('boom'));
        }
        return Promise.resolve();
      })
      .retry('a', { maxAttempts: 2 })
      .build();

    const first = await runJob(job, { page, repository: repo, delay: noDelay });
    expect(first.status).toBe('FAILED');
    expect(calls).toBe(2); // 2 attempts in the first run

    const second = await runJob(job, { page, repository: repo, delay: noDelay });
    expect(second.restarted).toBe(true);
    expect(second.status).toBe('COMPLETED');
    expect(calls).toBe(3); // one more attempt on restart, with a fresh budget
    expect(await attemptsOf(second.executionId, 'a')).toBe(1);
  });
});
