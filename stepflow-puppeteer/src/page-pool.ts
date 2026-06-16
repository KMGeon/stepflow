import type { Browser, BrowserContext, Page } from 'puppeteer';

/** A borrowed page bound to its own {@link BrowserContext}. Return it with {@link PageLease.close}. */
export interface PageLease {
  readonly page: Page;
  readonly browser: Browser;
  /**
   * Close this lease's context (and its page) and free the pool slot. Idempotent —
   * safe to call from both a timeout force-close and a normal `finally`.
   */
  close(): Promise<void>;
}

/** Options for {@link createPagePool}. */
export interface PagePoolOptions {
  /**
   * Launch (or connect to) a browser. Injected so tests need no real Chromium and
   * callers control launch args. The pool calls this lazily on first acquire and
   * again to recover if the browser has died.
   */
  readonly launch: () => Promise<Browser>;
  /** Maximum number of concurrently-leased pages (each in its own context). Must be >= 1. */
  readonly concurrency: number;
}

/**
 * A bounded pool of Puppeteer pages, one isolated {@link BrowserContext} per lease.
 *
 * - `acquire()` waits when all slots are in use, then hands out a fresh context+page.
 * - `close()` on the lease disposes the context (no cross-job state bleed) and frees the slot.
 * - One shared browser process backs all contexts; it is relaunched if it dies.
 * - `drain()` closes the browser (and thus every context) and rejects further acquires.
 */
export interface PagePool {
  acquire(): Promise<PageLease>;
  drain(): Promise<void>;
}

/** Build a {@link PagePool}. */
export function createPagePool(options: PagePoolOptions): PagePool {
  const { launch } = options;
  const concurrency = Math.max(1, Math.floor(options.concurrency));

  let browser: Browser | null = null;
  // Memoize the launch so concurrent first-acquires share ONE browser (no double-launch).
  let browserPromise: Promise<Browser> | null = null;
  let active = 0;
  let drained = false;
  const waiters: (() => void)[] = [];

  function acquireSlot(): Promise<void> {
    if (active < concurrency) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        active += 1;
        resolve();
      });
    });
  }

  function releaseSlot(): void {
    active -= 1;
    const next = waiters.shift();
    if (next) {
      next();
    }
  }

  function ensureBrowser(): Promise<Browser> {
    browserPromise ??= launch().then((b) => {
      browser = b;
      return b;
    });
    return browserPromise;
  }

  async function newContext(): Promise<BrowserContext> {
    const current = await ensureBrowser();
    try {
      return await current.createBrowserContext();
    } catch {
      // The browser likely died — drop it, relaunch once, and retry.
      browser = null;
      browserPromise = null;
      const fresh = await ensureBrowser();
      return fresh.createBrowserContext();
    }
  }

  return {
    async acquire(): Promise<PageLease> {
      if (drained) {
        throw new Error('PagePool is drained');
      }
      await acquireSlot();
      try {
        const context = await newContext();
        const page = await context.newPage();
        const owner = browser;
        if (owner === null) {
          throw new Error('PagePool: browser unavailable after context creation');
        }
        let closed = false;
        return {
          page,
          browser: owner,
          async close(): Promise<void> {
            if (closed) {
              return;
            }
            closed = true;
            try {
              await context.close();
            } catch {
              // Context already gone (browser closed / crashed) — nothing to do.
            }
            releaseSlot();
          },
        };
      } catch (error) {
        releaseSlot();
        throw error;
      }
    },

    async drain(): Promise<void> {
      drained = true;
      const current = browser;
      browser = null;
      browserPromise = null;
      if (current !== null) {
        try {
          await current.close();
        } catch {
          // Ignore — best-effort teardown.
        }
      }
    },
  };
}
