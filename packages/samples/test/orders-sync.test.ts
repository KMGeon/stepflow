import { InMemoryJobRepository } from '@stepflow/core';
import { createFakePage } from '@stepflow/test';
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
});
