import type { Page } from 'puppeteer';
import { beforeEach, describe, expect, it } from 'vitest';

import { defineJob } from '../src/define-job';
import { runJob } from '../src/run-job';
import { InMemoryJobRepository } from '../src/in-memory';
import type { JobListener } from '../src/listeners';

const page = {} as unknown as Page;

let repo: InMemoryJobRepository;

beforeEach(() => {
  repo = new InMemoryJobRepository();
});

/** A listener that appends a string tag for every call it receives. */
function recorder(events: string[]): JobListener {
  return {
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
    onStepError: (_ctx, step) => {
      events.push(`onStepError:${step.stepName}`);
    },
  };
}

describe('runJob — listeners', () => {
  it('emits lifecycle events in order for a successful linear job', async () => {
    const events: string[] = [];
    const job = defineJob('lc')
      .step('a', async () => undefined)
      .step('b', async () => undefined)
      .build();

    await runJob(job, { page, repository: repo, listeners: [recorder(events)] });

    expect(events).toEqual([
      'beforeJob:lc',
      'beforeStep:a',
      'afterStep:a:COMPLETED',
      'beforeStep:b',
      'afterStep:b:COMPLETED',
      'afterJob:COMPLETED',
    ]);
  });

  it('emits onStepError before afterStep when a step throws', async () => {
    const events: string[] = [];
    const job = defineJob('lc')
      .step('a', async () => undefined)
      .step('b', async () => {
        throw new Error('boom');
      })
      .build();

    const result = await runJob(job, { page, repository: repo, listeners: [recorder(events)] });

    expect(result.status).toBe('FAILED');
    expect(events).toEqual([
      'beforeJob:lc',
      'beforeStep:a',
      'afterStep:a:COMPLETED',
      'beforeStep:b',
      'onStepError:b',
      'afterStep:b:FAILED',
      'afterJob:FAILED',
    ]);
  });

  it('emits onStepError for an explicit FAILED return (no throw)', async () => {
    const events: string[] = [];
    const job = defineJob('lc')
      .step('a', async () => 'FAILED')
      .build();

    await runJob(job, { page, repository: repo, listeners: [recorder(events)] });

    expect(events).toEqual([
      'beforeJob:lc',
      'beforeStep:a',
      'onStepError:a',
      'afterStep:a:FAILED',
      'afterJob:FAILED',
    ]);
  });

  it('isolates a throwing listener: the job still completes and the error is logged', async () => {
    const logged: string[] = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (message: string, _meta?: Record<string, unknown>) => {
        logged.push(message);
      },
    };
    const ran: string[] = [];
    const exploding: JobListener = {
      beforeStep: () => {
        throw new Error('listener kaboom');
      },
    };
    const job = defineJob('iso')
      .step('a', async () => {
        ran.push('a');
      })
      .build();

    const result = await runJob(job, {
      page,
      repository: repo,
      logger,
      listeners: [exploding],
    });

    expect(result.status).toBe('COMPLETED');
    expect(ran).toEqual(['a']);
    expect(logged.some((m) => m.includes('listener'))).toBe(true);
  });

  it('does not emit step events for carry-forward steps on restart', async () => {
    const attempts = { process: 0 };
    const job = defineJob('restartable')
      .step('login', async () => undefined)
      .step('search', async () => undefined)
      .step('process', async () => {
        attempts.process += 1;
        if (attempts.process === 1) throw new Error('flaky');
      })
      .build();

    // First run fails at 'process'.
    const first = await runJob(job, { page, repository: repo });
    expect(first.status).toBe('FAILED');

    // Second run restarts; only the resumed 'process' step should emit.
    const events: string[] = [];
    const second = await runJob(job, { page, repository: repo, listeners: [recorder(events)] });

    expect(second.restarted).toBe(true);
    expect(second.status).toBe('COMPLETED');
    expect(events).toEqual([
      'beforeJob:restartable',
      'beforeStep:process',
      'afterStep:process:COMPLETED',
      'afterJob:COMPLETED',
    ]);
  });
});
