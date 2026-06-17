import { describe, expect, it } from 'vitest';

import * as stepflow from '../src/index';

describe('stepflow umbrella', () => {
  it('re-exports the core engine entry points', () => {
    expect(typeof stepflow.defineJob).toBe('function');
    expect(typeof stepflow.runJob).toBe('function');
    expect(typeof stepflow.InMemoryJobRepository).toBe('function');
    expect(stepflow.COMPLETED).toBe('COMPLETED');
    expect(stepflow.FAILED).toBe('FAILED');
  });

  it('re-exports the parallel Puppeteer runtime', () => {
    expect(typeof stepflow.runJobsParallel).toBe('function');
    expect(typeof stepflow.createPagePool).toBe('function');
  });

  it('re-exports the durable repositories', () => {
    expect(typeof stepflow.MySqlJobRepository).toBe('function');
    expect(typeof stepflow.SqliteJobRepository).toBe('function');
  });

  it('actually runs a job through the re-exported engine', async () => {
    const job = stepflow
      .defineJob('umbrella-smoke')
      .step('a', async () => undefined)
      .build();
    const result = await stepflow.runJob(job, {
      page: {} as never,
      repository: new stepflow.InMemoryJobRepository(),
    });
    expect(result.status).toBe('COMPLETED');
  });
});
