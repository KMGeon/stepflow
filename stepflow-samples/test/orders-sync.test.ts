import { InMemoryJobRepository } from '@kmgeon/stepflow-core';
import { createFakePage } from '@kmgeon/stepflow-test';
import { describe, expect, it } from 'vitest';

import { ordersSync, runOrdersSync } from '../src/orders-sync';

describe('sample: orders_sync', () => {
  it('builds with the expected name, entry, and linear order', () => {
    expect(ordersSync.name).toBe('orders_sync');
    expect(ordersSync.entry).toBe('login');
    expect(ordersSync.steps.map((s) => s.name)).toEqual([
      'login',
      'search',
      'parse',
      'confirm',
      'cleanup',
    ]);
  });

  it('routes the empty-result branch to cleanup, skipping confirm', () => {
    expect(ordersSync.next('parse', 'EMPTY')).toBe('cleanup');
    expect(ordersSync.next('parse', 'COMPLETED')).toBe('confirm');
    expect(ordersSync.next('confirm', 'COMPLETED')).toBe('cleanup');
    expect(ordersSync.next('cleanup', 'COMPLETED')).toBeNull();
  });

  it('runs end-to-end on a fake page: an empty result takes the cleanup branch', async () => {
    const page = createFakePage({
      goto: () => Promise.resolve(null),
      type: () => Promise.resolve(),
      click: () => Promise.resolve(),
      waitForNavigation: () => Promise.resolve(null),
      waitForSelector: () => Promise.resolve(null),
      $$eval: () => Promise.resolve(0), // no rows → 'EMPTY' → cleanup
    });

    const result = await runOrdersSync(page, new InMemoryJobRepository());

    expect(result.status).toBe('COMPLETED');
    expect(result.exitStatus).toBe('COMPLETED'); // cleanup completes the job
  });

  it('restarts from the failed step, skipping completed steps (e2e round-trip)', async () => {
    const calls = { type: 0, confirmWait: 0 };
    const page = createFakePage({
      goto: () => Promise.resolve(null),
      type: () => {
        calls.type += 1;
        return Promise.resolve();
      },
      click: () => Promise.resolve(),
      waitForNavigation: () => Promise.resolve(null),
      $$eval: () => Promise.resolve(3), // rows present → 'COMPLETED' → confirm path
      waitForSelector: (selector: string) => {
        if (selector === '#confirm-done') {
          calls.confirmWait += 1;
          if (calls.confirmWait === 1) throw new Error('confirm timeout');
        }
        return Promise.resolve(null);
      },
    });
    const repo = new InMemoryJobRepository();

    const first = await runOrdersSync(page, repo);
    expect(first.status).toBe('FAILED');
    expect(calls.type).toBe(2); // login typed username + password

    const second = await runOrdersSync(page, repo);
    expect(second.status).toBe('COMPLETED');
    expect(second.restarted).toBe(true);
    expect(calls.type).toBe(2); // login skipped on restart → no new type() calls
    expect(calls.confirmWait).toBe(2); // confirm re-ran and succeeded
  });
});
