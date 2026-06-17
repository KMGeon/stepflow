import { describe, expect, it } from 'vitest';

import { createFakePage } from '../../src/test/fake-page';

describe('createFakePage', () => {
  it('runs a stubbed method', async () => {
    const page = createFakePage({ title: () => Promise.resolve('home') });
    await expect(page.title()).resolves.toBe('home');
  });

  it('throws descriptively for an unstubbed method', () => {
    const page = createFakePage();
    expect(() => page.url()).toThrow(/page\.url\(\) is not stubbed/);
  });

  it('is not thenable: awaiting the page yields the page itself', async () => {
    const page = createFakePage();
    const awaited = await (page as unknown as Promise<unknown>);
    expect(awaited).toBe(page);
  });

  it('returns non-function handler values as-is (getter-style members)', () => {
    const fakeMouse = { moved: true };
    const page = createFakePage({ mouse: fakeMouse });
    expect(page.mouse as unknown).toBe(fakeMouse);
  });
});
