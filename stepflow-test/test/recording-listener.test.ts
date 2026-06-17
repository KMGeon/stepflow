import { defineJob, InMemoryJobRepository, runJob } from '@kmgeon/stepflow-core';
import type { Page } from 'puppeteer';
import { describe, expect, it } from 'vitest';

import { createRecordingListener } from '../src/recording-listener';

const page = {} as unknown as Page;

describe('createRecordingListener', () => {
  it('records the lifecycle events of a job run as ordered tags', async () => {
    const repo = new InMemoryJobRepository();
    const rec = createRecordingListener();
    const job = defineJob('rec')
      .step('a', async () => undefined)
      .build();

    await runJob(job, { page, repository: repo, listeners: [rec] });

    expect(rec.events).toEqual([
      'beforeJob:rec',
      'beforeStep:a',
      'afterStep:a:COMPLETED',
      'afterJob:COMPLETED',
    ]);
  });

  it('records onStepError with the error message when a step throws', async () => {
    const repo = new InMemoryJobRepository();
    const rec = createRecordingListener();
    const job = defineJob('rec')
      .step('a', async () => {
        throw new Error('kaboom');
      })
      .build();

    await runJob(job, { page, repository: repo, listeners: [rec] });

    expect(rec.events).toEqual([
      'beforeJob:rec',
      'beforeStep:a',
      'onStepError:a:kaboom',
      'afterStep:a:FAILED',
      'afterJob:FAILED',
    ]);
  });
});
