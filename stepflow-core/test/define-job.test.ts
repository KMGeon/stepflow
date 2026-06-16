import { describe, expect, it } from 'vitest';

import { defineJob, JobDefinitionError } from '../src/define-job';

const noop = (): Promise<void> => Promise.resolve();

describe('defineJob / build', () => {
  it('registers steps in order; entry is the first step; seqNo is 1-based', () => {
    const job = defineJob('j').step('a', noop).step('b', noop).build();
    expect(job.name).toBe('j');
    expect(job.entry).toBe('a');
    expect(job.steps.map((s) => s.name)).toEqual(['a', 'b']);
    expect(job.stepAt('a').seqNo).toBe(1);
    expect(job.stepAt('b').seqNo).toBe(2);
  });

  it('links steps linearly on COMPLETED and ends after the last step', () => {
    const job = defineJob('j').step('a', noop).step('b', noop).build();
    expect(job.next('a', 'COMPLETED')).toBe('b');
    expect(job.next('b', 'COMPLETED')).toBeNull();
  });

  it('ends the job for an exit status that has no transition', () => {
    const job = defineJob('j').step('a', noop).step('b', noop).build();
    expect(job.next('a', 'FAILED')).toBeNull();
    expect(job.next('a', 'EMPTY')).toBeNull();
  });

  it('applies a branch override while keeping the linear COMPLETED default', () => {
    const job = defineJob('j')
      .step('parse', noop)
      .step('confirm', noop)
      .step('cleanup', noop)
      .branch('parse', { EMPTY: 'cleanup' })
      .build();
    expect(job.next('parse', 'COMPLETED')).toBe('confirm');
    expect(job.next('parse', 'EMPTY')).toBe('cleanup');
    expect(job.next('parse', 'FAILED')).toBeNull();
  });

  it('lets a branch override the COMPLETED transition explicitly', () => {
    // COMPLETED jumps to 'c'; 'b' stays reachable via the RETRY edge.
    const job = defineJob('j')
      .step('a', noop)
      .step('b', noop)
      .step('c', noop)
      .branch('a', { COMPLETED: 'c', RETRY: 'b' })
      .build();
    expect(job.next('a', 'COMPLETED')).toBe('c');
    expect(job.next('a', 'RETRY')).toBe('b');
  });

  it('merges multiple branch calls on the same step', () => {
    const job = defineJob('j')
      .step('a', noop)
      .step('b', noop)
      .step('c', noop)
      .branch('a', { X: 'b' })
      .branch('a', { Y: 'c' })
      .build();
    expect(job.next('a', 'X')).toBe('b');
    expect(job.next('a', 'Y')).toBe('c');
  });

  it('rejects a job with no steps', () => {
    expect(() => defineJob('empty').build()).toThrow(JobDefinitionError);
  });

  it('rejects duplicate step names', () => {
    expect(() => defineJob('j').step('a', noop).step('a', noop).build()).toThrow(/duplicate/i);
  });

  it('rejects a branch on an unknown step', () => {
    expect(() => defineJob('j').step('a', noop).branch('ghost', { X: 'a' }).build()).toThrow(
      /ghost/,
    );
  });

  it('rejects a branch to an unknown target step', () => {
    expect(() =>
      defineJob('j').step('a', noop).step('b', noop).branch('a', { X: 'ghost' }).build(),
    ).toThrow(/ghost/);
  });

  it('rejects an unreachable step', () => {
    expect(() =>
      defineJob('j').step('a', noop).step('b', noop).branch('a', { COMPLETED: 'a' }).build(),
    ).toThrow(/unreachable/i);
  });

  it('returns a frozen job definition', () => {
    const job = defineJob('j').step('a', noop).build();
    expect(Object.isFrozen(job)).toBe(true);
  });

  it('stepAt throws for an unknown step name', () => {
    const job = defineJob('j').step('a', noop).build();
    expect(() => job.stepAt('ghost')).toThrow();
  });
});
