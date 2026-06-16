import type { RunJobResult } from '@stepflow/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { intervalTrigger } from '../src/interval-trigger';

const result: RunJobResult = {
  instanceId: 1,
  executionId: 1,
  status: 'COMPLETED',
  exitStatus: 'COMPLETED',
  restarted: false,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('intervalTrigger', () => {
  it('fires the runner every period and stops on stop()', async () => {
    let calls = 0;
    const trigger = intervalTrigger(100);
    const handle = await trigger.start(() => {
      calls += 1;
      return Promise.resolve(result);
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toBe(3);

    await handle.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(3); // no further firing after stop
  });

  it('keeps firing after a run rejects', async () => {
    let calls = 0;
    const trigger = intervalTrigger(100);
    await trigger.start(() => {
      calls += 1;
      return Promise.reject(new Error('boom'));
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toBe(3);
  });

  it('skips ticks while a run is still in flight (no overlap)', async () => {
    let starts = 0;
    let release: () => void = () => undefined;
    const trigger = intervalTrigger(100);
    await trigger.start(() => {
      starts += 1;
      return new Promise<RunJobResult>((res) => {
        release = () => {
          res(result);
        };
      });
    });

    await vi.advanceTimersByTimeAsync(100); // tick 1 -> run starts and stays in flight
    expect(starts).toBe(1);

    await vi.advanceTimersByTimeAsync(300); // ticks 2-4 skipped while in flight
    expect(starts).toBe(1);

    release(); // complete the in-flight run
    await vi.advanceTimersByTimeAsync(100); // the next tick can now run
    expect(starts).toBe(2);
  });
});
