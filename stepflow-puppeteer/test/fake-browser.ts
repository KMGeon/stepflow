import { createFakePage } from '@kmgeon/stepflow-test';
import type { Browser } from 'puppeteer';

/** A Puppeteer {@link Browser} test double that counts context/browser lifecycle calls. */
export interface FakeBrowserHandle {
  readonly browser: Browser;
  contextsOpened(): number;
  contextsClosed(): number;
  browserClosed(): boolean;
}

/** Build a fake browser whose contexts hand out {@link createFakePage} pages. */
export function createFakeBrowser(): FakeBrowserHandle {
  let opened = 0;
  let closed = 0;
  let browserClosed = false;
  const browser = {
    createBrowserContext: () => {
      opened += 1;
      return Promise.resolve({
        newPage: () => Promise.resolve(createFakePage()),
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      });
    },
    close: () => {
      browserClosed = true;
      return Promise.resolve();
    },
  } as unknown as Browser;
  return {
    browser,
    contextsOpened: () => opened,
    contextsClosed: () => closed,
    browserClosed: () => browserClosed,
  };
}
