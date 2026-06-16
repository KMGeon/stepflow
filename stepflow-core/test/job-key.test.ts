import { describe, expect, it } from 'vitest';

import { computeJobKey } from '../src/metadata/job-key';

describe('computeJobKey', () => {
  it('is stable for the same jobName and params', () => {
    expect(computeJobKey('orders_sync', { date: '2026-06-13' })).toBe(
      computeJobKey('orders_sync', { date: '2026-06-13' }),
    );
  });

  it('ignores parameter insertion order', () => {
    expect(computeJobKey('job', { a: '1', b: '2' })).toBe(computeJobKey('job', { b: '2', a: '1' }));
  });

  it('differs when a parameter value differs', () => {
    expect(computeJobKey('job', { date: '2026-06-13' })).not.toBe(
      computeJobKey('job', { date: '2026-06-14' }),
    );
  });

  it('differs when the jobName differs', () => {
    expect(computeJobKey('a', {})).not.toBe(computeJobKey('b', {}));
  });

  it('is stable for an empty parameter set (one instance per jobName)', () => {
    expect(computeJobKey('job', {})).toBe(computeJobKey('job', {}));
  });

  it('distinguishes a present empty value from an absent key', () => {
    expect(computeJobKey('job', { a: '' })).not.toBe(computeJobKey('job', {}));
  });

  it('is not fooled by key/value boundary collisions', () => {
    expect(computeJobKey('job', { ab: 'c' })).not.toBe(computeJobKey('job', { a: 'bc' }));
  });

  it('returns a 64-char lowercase hex sha-256 digest', () => {
    expect(computeJobKey('job', { x: '1' })).toMatch(/^[0-9a-f]{64}$/);
  });
});
