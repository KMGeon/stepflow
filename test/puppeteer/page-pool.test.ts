import type { Browser } from 'puppeteer';
import { describe, expect, it } from 'vitest';

import { createPagePool } from '../../src/puppeteer/page-pool';
import { createFakeBrowser } from './fake-browser';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createPagePool', () => {
  it('hands out a page in its own context and frees the slot on close', async () => {
    const fb = createFakeBrowser();
    const pool = createPagePool({ launch: () => Promise.resolve(fb.browser), concurrency: 2 });

    const lease = await pool.acquire();
    expect(lease.page).toBeDefined();
    expect(lease.browser).toBe(fb.browser);
    expect(fb.contextsOpened()).toBe(1);

    await lease.close();
    expect(fb.contextsClosed()).toBe(1);

    await pool.drain();
    expect(fb.browserClosed()).toBe(true);
  });

  it('caps concurrency: a 3rd acquire waits until a slot frees', async () => {
    const fb = createFakeBrowser();
    const pool = createPagePool({ launch: () => Promise.resolve(fb.browser), concurrency: 2 });

    const a = await pool.acquire();
    const b = await pool.acquire();
    let thirdReady = false;
    const third = pool.acquire().then((l) => {
      thirdReady = true;
      return l;
    });

    await tick();
    expect(thirdReady).toBe(false); // capped at 2 — the 3rd is queued

    await a.close(); // free one slot
    const c = await third;
    expect(thirdReady).toBe(true);

    await b.close();
    await c.close();
    await pool.drain();
  });

  it('launches the browser once even under concurrent first-acquires', async () => {
    let launches = 0;
    const fb = createFakeBrowser();
    const pool = createPagePool({
      launch: () => {
        launches += 1;
        return Promise.resolve(fb.browser);
      },
      concurrency: 3,
    });

    const [a, b, c] = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
    expect(launches).toBe(1); // memoized launch — no double-launch

    await a.close();
    await b.close();
    await c.close();
    await pool.drain();
  });

  it('close() is idempotent', async () => {
    const fb = createFakeBrowser();
    const pool = createPagePool({ launch: () => Promise.resolve(fb.browser), concurrency: 1 });

    const lease = await pool.acquire();
    await lease.close();
    await lease.close();

    expect(fb.contextsClosed()).toBe(1); // closed once despite two calls
    await pool.drain();
  });

  it('rejects acquire after drain', async () => {
    const fb = createFakeBrowser();
    const pool = createPagePool({ launch: () => Promise.resolve(fb.browser), concurrency: 1 });

    await pool.drain();

    await expect(pool.acquire()).rejects.toThrow(/drained/);
  });

  it('relaunches the browser if context creation fails (crash recovery)', async () => {
    let launches = 0;
    const healthy = createFakeBrowser();
    const dead = {
      createBrowserContext: () => Promise.reject(new Error('browser is dead')),
      close: () => Promise.resolve(),
    } as unknown as Browser;

    const pool = createPagePool({
      launch: () => {
        launches += 1;
        return Promise.resolve(launches === 1 ? dead : healthy.browser);
      },
      concurrency: 1,
    });

    const lease = await pool.acquire();
    expect(launches).toBe(2); // first (dead) browser dropped, relaunched
    expect(healthy.contextsOpened()).toBe(1);

    await lease.close();
    await pool.drain();
  });

  it('relaunches exactly once under CONCURRENT crash recovery (no orphaned browsers)', async () => {
    let launches = 0;
    const healthy = createFakeBrowser();
    const dead = {
      createBrowserContext: () => Promise.reject(new Error('browser is dead')),
      close: () => Promise.resolve(),
    } as unknown as Browser;

    const pool = createPagePool({
      launch: () => {
        launches += 1;
        return Promise.resolve(launches === 1 ? dead : healthy.browser);
      },
      concurrency: 3,
    });

    // Three concurrent acquires all hit the dead browser at once.
    const leases = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);

    expect(launches).toBe(2); // 1 dead + exactly 1 healthy relaunch — no storm
    expect(healthy.contextsOpened()).toBe(3); // all contexts from the single relaunched browser

    for (const lease of leases) {
      await lease.close();
    }
    await pool.drain();
    expect(healthy.browserClosed()).toBe(true); // the one live browser closed — nothing orphaned
  });
});
