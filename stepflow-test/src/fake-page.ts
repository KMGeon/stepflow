import type { Page } from 'puppeteer';

/**
 * Stubs for the Puppeteer Page members a test exercises. A value is returned
 * as-is, so both methods (`goto: () => ...`) and property-style members
 * (`mouse: fakeMouse`) can be stubbed.
 */
export type FakePageHandlers = Record<string, unknown>;

/**
 * A Puppeteer `Page` test double. Members you provide in `handlers` are
 * returned as given; any other method call throws a descriptive error, so a step
 * that unexpectedly touches the page fails loudly instead of silently no-op-ing.
 *
 * The double is deliberately **not thenable** (`then` and symbol keys read as
 * absent), so awaiting or returning the page never triggers a phantom promise.
 */
export function createFakePage(handlers: FakePageHandlers = {}): Page {
  return new Proxy(
    {},
    {
      get(_target, property) {
        // Symbols and `then` must read as absent: never thenable, never matched
        // against a well-known-symbol protocol.
        if (typeof property === 'symbol' || property === 'then') {
          return undefined;
        }
        if (property in handlers) {
          return handlers[property];
        }
        return () => {
          throw new Error(`FakePage: page.${property}() is not stubbed`);
        };
      },
    },
  ) as unknown as Page;
}
