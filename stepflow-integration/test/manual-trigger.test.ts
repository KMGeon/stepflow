import type { RunJobResult } from '@kmgeon/stepflow-core';
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

  it('fires repeatedly while started', async () => {
    const trigger = createManualTrigger();
    let calls = 0;
    await trigger.start(() => {
      calls += 1;
      return Promise.resolve(result);
    });

    await trigger.fire();
    await trigger.fire();

    expect(calls).toBe(2);
  });

  it('rejects (does not synchronously throw) when fired before start', async () => {
    const trigger = createManualTrigger();
    await expect(trigger.fire()).rejects.toThrow(/before start/);
  });

  it('rejects when fired after stop', async () => {
    const trigger = createManualTrigger();
    const handle = await trigger.start(() => Promise.resolve(result));
    await handle.stop();

    await expect(trigger.fire()).rejects.toThrow();
  });

  it('can be restarted after stop', async () => {
    const trigger = createManualTrigger();
    const first = await trigger.start(() => Promise.resolve(result));
    await first.stop();
    await trigger.start(() => Promise.resolve(result));

    await expect(trigger.fire()).resolves.toBe(result);
  });

  it('stopping a stale handle does not kill the current runner', async () => {
    const trigger = createManualTrigger();
    const stale = await trigger.start(() => Promise.resolve(result));
    await trigger.start(() => Promise.resolve(result)); // re-start; stale handle is now obsolete
    await stale.stop(); // must NOT clear the active runner

    await expect(trigger.fire()).resolves.toBe(result);
  });
});
