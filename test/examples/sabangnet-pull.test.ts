import { describe, expect, it } from 'vitest';

import { sabangnetPull } from '../../examples/sabangnet-pull';

describe('example: sabangnet_pull', () => {
  it('builds with the expected name, entry, and linear order', () => {
    expect(sabangnetPull.name).toBe('sabangnet_pull');
    expect(sabangnetPull.entry).toBe('login');
    expect(sabangnetPull.steps.map((s) => s.name)).toEqual([
      'login',
      'search',
      'parse',
      'confirm',
      'cleanup',
    ]);
  });

  it('routes the empty-result branch to cleanup, skipping confirm', () => {
    expect(sabangnetPull.next('parse', 'EMPTY')).toBe('cleanup');
    expect(sabangnetPull.next('parse', 'COMPLETED')).toBe('confirm');
    expect(sabangnetPull.next('confirm', 'COMPLETED')).toBe('cleanup');
    expect(sabangnetPull.next('cleanup', 'COMPLETED')).toBeNull();
  });
});
