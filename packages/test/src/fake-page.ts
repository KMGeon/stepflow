import type { Page } from 'puppeteer';

/** Stub implementations for the Puppeteer Page methods a test actually exercises. */
export type FakePageHandlers = Record<string, (...args: never[]) => unknown>;

/**
 * A Puppeteer {@link Page} test double. Methods you provide in `handlers` run as
 * given; any other method call throws a descriptive error, so a step that
 * unexpectedly touches the page fails loudly instead of silently no-op-ing.
 */
export function createFakePage(handlers: FakePageHandlers = {}): Page {
  return new Proxy(
    {},
    {
      get(_target, property) {
        const key = String(property);
        if (key in handlers) {
          return handlers[key];
        }
        return () => {
          throw new Error(`FakePage: page.${key}() is not stubbed`);
        };
      },
    },
  ) as unknown as Page;
}
