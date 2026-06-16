import type { RunJobResult } from '@stepflow/core';
import { describe, expect, it } from 'vitest';

import { createManualTrigger } from '../src/index';

const result: RunJobResult = {
  instanceId: 1,
  executionId: 1,
  status: 'COMPLETED',
  exitStatus: 'COMPLETED',
  restarted: false,
};

describe('createManualTrigger', () => {
  it('fires the registered runner and returns its result', async () => {
    const trigger = createManualTrigger();
    let calls = 0;
    await trigger.start(() => {
      calls += 1;
      return Promise.resolve(result);
    });

    const out = await trigger.fire();

    expect(out).toBe(result);
    expect(calls).toBe(1);
  });

  it('throws when fired before start', () => {
    const trigger = createManualTrigger();
    expect(() => trigger.fire()).toThrow(/before start/);
  });

  it('throws when fired after stop', async () => {
    const trigger = createManualTrigger();
    const handle = await trigger.start(() => Promise.resolve(result));
    await handle.stop();

    expect(() => trigger.fire()).toThrow();
  });
});
