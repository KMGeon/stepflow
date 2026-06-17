import type { Page } from 'puppeteer';
import { beforeEach, describe, expect, it } from 'vitest';

import { defineJob } from '../src/builder/define-job';
import { runJob } from '../src/engine/run-job';
import { InMemoryJobRepository } from '../src/repository/in-memory';

const page = {} as unknown as Page;

let repo: InMemoryJobRepository;

beforeEach(() => {
  repo = new InMemoryJobRepository();
});

describe('runJob — signal passthrough', () => {
  it('exposes the provided AbortSignal to steps via ctx.signal', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const job = defineJob('s')
      .step('a', async (ctx) => {
        seen = ctx.signal;
      })
      .build();

    await runJob(job, { page, repository: repo, signal: controller.signal });

    expect(seen).toBe(controller.signal);
  });

  it('reflects an already-aborted signal to the step', async () => {
    const controller = new AbortController();
    controller.abort();
    let aborted: boolean | undefined;
    const job = defineJob('s')
      .step('a', async (ctx) => {
        aborted = ctx.signal?.aborted;
      })
      .build();

    await runJob(job, { page, repository: repo, signal: controller.signal });

    expect(aborted).toBe(true);
  });

  it('leaves ctx.signal undefined when no signal is provided', async () => {
    let hadSignal: boolean | undefined;
    const job = defineJob('s')
      .step('a', async (ctx) => {
        hadSignal = ctx.signal !== undefined;
      })
      .build();

    await runJob(job, { page, repository: repo });

    expect(hadSignal).toBe(false);
  });
});
