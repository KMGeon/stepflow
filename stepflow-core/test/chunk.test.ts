import type { Page } from 'puppeteer';
import { beforeEach, describe, expect, it } from 'vitest';

import { defineJob } from '../src/builder/define-job';
import { runJob } from '../src/engine/run-job';
import { InMemoryJobRepository } from '../src/repository/in-memory';
import type { JobListener } from '../src/engine/listeners';
import type { ChunkInfo } from '../src/engine/chunk';

const page = {} as unknown as Page;

let repo: InMemoryJobRepository;

beforeEach(() => {
  repo = new InMemoryJobRepository();
});

async function countsOf(
  executionId: number,
  stepName: string,
): Promise<{ readCount: number; writeCount: number } | undefined> {
  const steps = await repo.findStepExecutions(executionId);
  const s = steps.find((x) => x.stepName === stepName);
  return s ? { readCount: s.counts.readCount, writeCount: s.counts.writeCount } : undefined;
}

describe('runJob — chunk', () => {
  it('processes all items in chunks and flushes a final partial chunk', async () => {
    const written: number[][] = [];
    const job = defineJob('c')
      .chunkStep<number, number>('process', {
        chunkSize: 2,
        reader: () => [1, 2, 3, 4, 5],
        writer: (items) => {
          written.push([...items]);
        },
      })
      .build();

    const result = await runJob(job, { page, repository: repo });

    expect(result.status).toBe('COMPLETED');
    expect(written).toEqual([[1, 2], [3, 4], [5]]);
    expect(await countsOf(result.executionId, 'process')).toEqual({ readCount: 5, writeCount: 5 });
  });

  it('applies the processor before writing', async () => {
    const written: number[][] = [];
    const job = defineJob('c')
      .chunkStep<number, number>('process', {
        chunkSize: 3,
        reader: () => [1, 2, 3],
        processor: (n) => n * 10,
        writer: (items) => {
          written.push([...items]);
        },
      })
      .build();

    await runJob(job, { page, repository: repo });

    expect(written).toEqual([[10, 20, 30]]);
  });

  it('writes items unchanged when no processor is given', async () => {
    const written: string[][] = [];
    const job = defineJob('c')
      .chunkStep<string, string>('process', {
        chunkSize: 2,
        reader: () => ['a', 'b', 'c'],
        writer: (items) => {
          written.push([...items]);
        },
      })
      .build();

    await runJob(job, { page, repository: repo });

    expect(written).toEqual([['a', 'b'], ['c']]);
  });

  it('handles an async reader', async () => {
    const written: number[][] = [];
    async function* gen(): AsyncGenerator<number> {
      yield 1;
      yield 2;
      yield 3;
    }
    const job = defineJob('c')
      .chunkStep<number, number>('process', {
        chunkSize: 2,
        reader: () => gen(),
        writer: (items) => {
          written.push([...items]);
        },
      })
      .build();

    const result = await runJob(job, { page, repository: repo });

    expect(result.status).toBe('COMPLETED');
    expect(written).toEqual([[1, 2], [3]]);
  });

  it('completes with no writes for an empty reader', async () => {
    let writes = 0;
    const job = defineJob('c')
      .chunkStep<number, number>('process', {
        chunkSize: 2,
        reader: () => [],
        writer: () => {
          writes += 1;
        },
      })
      .build();

    const result = await runJob(job, { page, repository: repo });

    expect(result.status).toBe('COMPLETED');
    expect(writes).toBe(0);
    expect(await countsOf(result.executionId, 'process')).toEqual({ readCount: 0, writeCount: 0 });
  });

  it('emits onChunk per committed chunk', async () => {
    const chunks: ChunkInfo[] = [];
    const listener: JobListener = {
      onChunk: (_ctx, _step, info) => {
        chunks.push(info);
      },
    };
    const job = defineJob('c')
      .chunkStep<number, number>('process', {
        chunkSize: 2,
        reader: () => [1, 2, 3, 4, 5],
        writer: () => undefined,
      })
      .build();

    await runJob(job, { page, repository: repo, listeners: [listener] });

    expect(chunks.map((c) => c.chunkIndex)).toEqual([1, 2, 3]);
    expect(chunks.map((c) => c.size)).toEqual([2, 2, 1]);
    expect(chunks.map((c) => c.writeCount)).toEqual([2, 4, 5]);
  });

  it('checkpoints committed chunks and resumes after them on restart', async () => {
    const writtenRuns: number[][] = [];
    let failArmed = true;
    const job = defineJob('c')
      .chunkStep<number, number>('process', {
        chunkSize: 2,
        reader: () => [1, 2, 3, 4, 5],
        writer: (items) => {
          // Fail the first time the [3,4] chunk is written (mid-step crash).
          if (failArmed && items[0] === 3) {
            failArmed = false;
            return Promise.reject(new Error('write boom'));
          }
          writtenRuns.push([...items]);
          return Promise.resolve();
        },
      })
      .build();

    const first = await runJob(job, { page, repository: repo });
    expect(first.status).toBe('FAILED');
    // Only the first chunk committed before the failure.
    expect(writtenRuns).toEqual([[1, 2]]);
    expect(await countsOf(first.executionId, 'process')).toEqual({ readCount: 4, writeCount: 2 });

    const second = await runJob(job, { page, repository: repo });
    expect(second.restarted).toBe(true);
    expect(second.status).toBe('COMPLETED');
    // Resumes after the committed prefix: writes only [3,4] and [5].
    expect(writtenRuns).toEqual([[1, 2], [3, 4], [5]]);
    expect(await countsOf(second.executionId, 'process')).toEqual({ readCount: 3, writeCount: 3 });
  });

  it('runs a chunk step within a flow alongside simple steps', async () => {
    const order: string[] = [];
    const job = defineJob('c')
      .step('before', async () => {
        order.push('before');
      })
      .chunkStep<number, number>('process', {
        chunkSize: 2,
        reader: () => [1, 2, 3],
        writer: (items) => {
          order.push(`chunk:${items.join(',')}`);
        },
      })
      .step('after', async () => {
        order.push('after');
      })
      .build();

    const result = await runJob(job, { page, repository: repo });

    expect(result.status).toBe('COMPLETED');
    expect(order).toEqual(['before', 'chunk:1,2', 'chunk:3', 'after']);
  });

  it('keeps chunk checkpoints out of the user shared bag', async () => {
    let seenSharedKeys: string[] = [];
    const job = defineJob('c')
      .chunkStep<number, number>('process', {
        chunkSize: 2,
        reader: () => [1, 2, 3],
        writer: () => undefined,
      })
      .step('after', async (ctx) => {
        seenSharedKeys = Object.keys(ctx.shared);
      })
      .build();

    const result = await runJob(job, { page, repository: repo });

    expect(result.status).toBe('COMPLETED');
    expect(seenSharedKeys).toEqual([]); // no internal checkpoint key leaks into shared
    expect((await repo.loadContext('JOB', result.executionId)) ?? {}).toEqual({});
    // The checkpoint lives in its own engine-private 'CHUNK' channel.
    expect(await repo.loadContext('CHUNK', result.executionId)).toEqual({ process: 3 });
  });

  it('ignores a user shared key on a fresh run (no spoofed checkpoint)', async () => {
    const written: number[][] = [];
    const job = defineJob('c')
      .step('seed', async (ctx) => {
        // A user key that looks like internal state must NOT affect chunk processing.
        ctx.shared.__stepflow_chunk_checkpoints__ = { process: 2 };
      })
      .chunkStep<number, number>('process', {
        chunkSize: 2,
        reader: () => [1, 2, 3, 4],
        writer: (items) => {
          written.push([...items]);
        },
      })
      .build();

    const result = await runJob(job, { page, repository: repo });

    expect(result.status).toBe('COMPLETED');
    expect(written).toEqual([
      [1, 2],
      [3, 4],
    ]); // all items processed; no items skipped
  });

  it('rejects a chunkSize below 1', () => {
    expect(() =>
      defineJob('c').chunkStep('p', {
        chunkSize: 0,
        reader: () => [],
        writer: () => undefined,
      }),
    ).toThrow(/chunkSize/);
  });

  it('rejects a retry policy on a chunk step at build()', () => {
    expect(() =>
      defineJob('c')
        .chunkStep('p', { chunkSize: 2, reader: () => [1], writer: () => undefined })
        .retry('p', { maxAttempts: 3 })
        .build(),
    ).toThrow(/chunk step/);
  });

  it('isolates a throwing onChunk listener (chunks still commit, job completes)', async () => {
    const written: number[][] = [];
    const listener: JobListener = {
      onChunk: () => {
        throw new Error('listener boom');
      },
    };
    const job = defineJob('c')
      .chunkStep<number, number>('process', {
        chunkSize: 2,
        reader: () => [1, 2, 3],
        writer: (items) => {
          written.push([...items]);
        },
      })
      .build();

    const result = await runJob(job, { page, repository: repo, listeners: [listener] });

    expect(result.status).toBe('COMPLETED');
    expect(written).toEqual([[1, 2], [3]]);
  });
});
