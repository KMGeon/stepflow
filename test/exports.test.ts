import { describe, expect, it } from 'vitest';

import { COMPLETED, FAILED, InMemoryJobRepository, defineJob, runJob } from '@kmgeon/stepflow';
import { createPagePool, runJobsParallel } from '@kmgeon/stepflow/puppeteer';
import { MySqlJobRepository, SqliteJobRepository } from '@kmgeon/stepflow/infrastructure';

describe('@kmgeon/stepflow package surface', () => {
  it('exposes the core engine entry points from the root', () => {
    expect(typeof defineJob).toBe('function');
    expect(typeof runJob).toBe('function');
    expect(typeof InMemoryJobRepository).toBe('function');
    expect(COMPLETED).toBe('COMPLETED');
    expect(FAILED).toBe('FAILED');
  });

  it('exposes the parallel Puppeteer runtime from ./puppeteer', () => {
    expect(typeof runJobsParallel).toBe('function');
    expect(typeof createPagePool).toBe('function');
  });

  it('exposes the durable repositories from ./infrastructure', () => {
    expect(typeof MySqlJobRepository).toBe('function');
    expect(typeof SqliteJobRepository).toBe('function');
  });

  it('actually runs a job through the engine', async () => {
    const job = defineJob('package-smoke')
      .step('a', async () => undefined)
      .build();
    const result = await runJob(job, {
      page: {} as never,
      repository: new InMemoryJobRepository(),
    });
    expect(result.status).toBe('COMPLETED');
  });
});
