import type { Page } from 'puppeteer';
import { beforeEach, describe, expect, it } from 'vitest';

import { defineJob } from '../src/builder/define-job';
import { runJob } from '../src/engine/run-job';
import { InMemoryJobRepository } from '../src/repository/in-memory';
import type { TimeoutScheduler } from '../src/engine/timeout';

const page = {} as unknown as Page;
const noDelay = (): Promise<void> => Promise.resolve();

/** A scheduler whose Nth handle (1-based) fires immediately; others never fire. */
const noop = (): undefined => undefined;

function fireOnAttempt(...attempts: number[]): TimeoutScheduler {
  let n = 0;
  return () => {
    n += 1;
    if (attempts.includes(n)) {
      return { promise: Promise.resolve(), cancel: noop };
    }
    return { promise: new Promise<void>(noop), cancel: noop };
  };
}

const pending = (): Promise<void> => new Promise<void>(noop);

let repo: InMemoryJobRepository;
beforeEach(() => {
  repo = new InMemoryJobRepository();
});

async function stepStatus(executionId: number, stepName: string): Promise<string | undefined> {
  const steps = await repo.findStepExecutions(executionId);
  return steps.find((s) => s.stepName === stepName)?.status;
}

describe('step timeout', () => {
  it('TC-1: a step that exceeds its timeout is recorded FAILED', async () => {
    const job = defineJob('j')
      .step('a', () => pending())
      .timeout('a', 50)
      .build();
    const result = await runJob(job, {
      page,
      repository: repo,
      delay: noDelay,
      timeoutScheduler: fireOnAttempt(1),
    });
    expect(result.status).toBe('FAILED');
    expect(await stepStatus(result.executionId, 'a')).toBe('FAILED');
  });

  it('TC-2: each retry attempt gets its own timeout (3 attempts then FAILED)', async () => {
    let calls = 0;
    const job = defineJob('j')
      .step('a', () => {
        calls += 1;
        return pending();
      })
      .timeout('a', 50)
      .retry('a', { maxAttempts: 3 })
      .build();
    const result = await runJob(job, {
      page,
      repository: repo,
      delay: noDelay,
      timeoutScheduler: fireOnAttempt(1, 2, 3),
    });
    expect(result.status).toBe('FAILED');
    expect(calls).toBe(3);
    const steps = await repo.findStepExecutions(result.executionId);
    expect(steps.find((s) => s.stepName === 'a')?.attempts).toBe(3);
  });

  it('TC-3: timeout on attempt 1, success on attempt 2 -> COMPLETED', async () => {
    let calls = 0;
    const job = defineJob('j')
      .step('a', () => {
        calls += 1;
        return calls === 1 ? pending() : Promise.resolve();
      })
      .timeout('a', 50)
      .retry('a', { maxAttempts: 3 })
      .build();
    const result = await runJob(job, {
      page,
      repository: repo,
      delay: noDelay,
      timeoutScheduler: fireOnAttempt(1),
    });
    expect(result.status).toBe('COMPLETED');
    expect(calls).toBe(2);
  });

  it('TC-4: on timeout the step-facing signal is aborted', async () => {
    let aborted: boolean | undefined;
    const job = defineJob('j')
      .step('a', (ctx) => {
        // record after the engine aborts; pending keeps the attempt open until timeout fires
        return new Promise<void>(() => {
          ctx.signal?.addEventListener('abort', () => {
            aborted = true;
          });
        });
      })
      .timeout('a', 50)
      .build();
    await runJob(job, {
      page,
      repository: repo,
      delay: noDelay,
      timeoutScheduler: fireOnAttempt(1),
    });
    expect(aborted).toBe(true);
  });

  it('TC-5: a step without a timeout is unaffected', async () => {
    let ran = false;
    const job = defineJob('j')
      .step('a', async () => {
        ran = true;
      })
      .build();
    const result = await runJob(job, { page, repository: repo, delay: noDelay });
    expect(result.status).toBe('COMPLETED');
    expect(ran).toBe(true);
  });
});
