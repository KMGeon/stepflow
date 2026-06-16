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
});
