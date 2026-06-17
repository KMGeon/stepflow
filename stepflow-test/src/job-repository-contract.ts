import { beforeEach, describe, expect, it } from 'vitest';

import type { JobRepository } from '@kmgeon/stepflow-core';

/**
 * Shared behavioural contract every {@link JobRepository} implementation must
 * satisfy. Both `InMemoryJobRepository` and `MySqlJobRepository` run this suite.
 *
 * `makeRepository` must return a clean, empty repository for each test.
 */
export function describeJobRepositoryContract(
  name: string,
  makeRepository: () => JobRepository | Promise<JobRepository>,
): void {
  describe(`${name} — JobRepository contract`, () => {
    let repo: JobRepository;

    beforeEach(async () => {
      repo = await makeRepository();
    });

    describe('resolveInstance', () => {
      it('creates an instance for a new (jobName, jobKey)', async () => {
        const inst = await repo.resolveInstance('job', 'key-1');
        expect(inst.jobName).toBe('job');
        expect(inst.jobKey).toBe('key-1');
        expect(inst.id).toBeGreaterThan(0);
      });

      it('is idempotent: the same (jobName, jobKey) returns the same instance id', async () => {
        const a = await repo.resolveInstance('job', 'key-1');
        const b = await repo.resolveInstance('job', 'key-1');
        expect(b.id).toBe(a.id);
      });

      it('creates distinct instances for different keys', async () => {
        const a = await repo.resolveInstance('job', 'key-1');
        const b = await repo.resolveInstance('job', 'key-2');
        expect(b.id).not.toBe(a.id);
      });
    });

    describe('executions', () => {
      it('findLastExecution is null before any execution', async () => {
        const inst = await repo.resolveInstance('job', 'k');
        expect(await repo.findLastExecution(inst.id)).toBeNull();
      });

      it('createExecution starts a STARTED execution that findLastExecution returns', async () => {
        const inst = await repo.resolveInstance('job', 'k');
        const exec = await repo.createExecution(inst.id, { date: '2026-06-13' });
        expect(exec.status).toBe('STARTED');
        expect(exec.instanceId).toBe(inst.id);
        expect(exec.endedAt).toBeNull();
        const last = await repo.findLastExecution(inst.id);
        expect(last?.id).toBe(exec.id);
      });

      it('findLastExecution returns the most recent execution', async () => {
        const inst = await repo.resolveInstance('job', 'k');
        const first = await repo.createExecution(inst.id, {});
        const second = await repo.createExecution(inst.id, {});
        expect(second.id).not.toBe(first.id);
        expect((await repo.findLastExecution(inst.id))?.id).toBe(second.id);
      });

      it('finishExecution records terminal status, exit status, error, and metadata', async () => {
        const inst = await repo.resolveInstance('job', 'k');
        const exec = await repo.createExecution(inst.id, {});
        await repo.finishExecution(exec.id, {
          status: 'FAILED',
          exitStatus: 'FAILED',
          error: 'boom',
          itemsCollected: 7,
          resultMeta: { inserted: 3 },
        });
        const last = await repo.findLastExecution(inst.id);
        expect(last?.status).toBe('FAILED');
        expect(last?.exitStatus).toBe('FAILED');
        expect(last?.error).toBe('boom');
        expect(last?.itemsCollected).toBe(7);
        expect(last?.resultMeta).toEqual({ inserted: 3 });
        expect(last?.endedAt).not.toBeNull();
        expect(last?.durationMs).toBeGreaterThanOrEqual(0);
      });

      it('scopes executions to their instance', async () => {
        const a = await repo.resolveInstance('job', 'a');
        const b = await repo.resolveInstance('job', 'b');
        await repo.createExecution(a.id, {});
        expect(await repo.findLastExecution(b.id)).toBeNull();
      });
    });

    describe('steps', () => {
      it('startStep creates a STARTED step that findStepExecutions returns', async () => {
        const inst = await repo.resolveInstance('job', 'k');
        const exec = await repo.createExecution(inst.id, {});
        const step = await repo.startStep(exec.id, 'login', 1);
        expect(step.status).toBe('STARTED');
        expect(step.stepName).toBe('login');
        expect(step.seqNo).toBe(1);
        const steps = await repo.findStepExecutions(exec.id);
        expect(steps).toHaveLength(1);
        expect(steps[0]?.id).toBe(step.id);
      });

      it('returns step executions in the order they were started', async () => {
        const inst = await repo.resolveInstance('job', 'k');
        const exec = await repo.createExecution(inst.id, {});
        // Started 'b' (seqNo 2) before 'a' (seqNo 1): start order wins, not seqNo.
        await repo.startStep(exec.id, 'b', 2);
        await repo.startStep(exec.id, 'a', 1);
        const steps = await repo.findStepExecutions(exec.id);
        expect(steps.map((s) => s.stepName)).toEqual(['b', 'a']);
      });

      it('finishStep records status, exit status, counts, duration, and attempts', async () => {
        const inst = await repo.resolveInstance('job', 'k');
        const exec = await repo.createExecution(inst.id, {});
        const step = await repo.startStep(exec.id, 'login', 1);
        await repo.finishStep(step.id, {
          status: 'COMPLETED',
          exitStatus: 'COMPLETED',
          durationMs: 42,
          counts: { readCount: 10 },
          attempts: 3,
        });
        const [persisted] = await repo.findStepExecutions(exec.id);
        expect(persisted?.status).toBe('COMPLETED');
        expect(persisted?.exitStatus).toBe('COMPLETED');
        expect(persisted?.durationMs).toBe(42);
        expect(persisted?.counts.readCount).toBe(10);
        expect(persisted?.counts.writeCount).toBe(0);
        expect(persisted?.attempts).toBe(3);
      });

      it('startStep defaults attempts to 1', async () => {
        const inst = await repo.resolveInstance('job', 'k');
        const exec = await repo.createExecution(inst.id, {});
        const step = await repo.startStep(exec.id, 'login', 1);
        expect(step.attempts).toBe(1);
      });

      it('scopes step executions to their execution', async () => {
        const inst = await repo.resolveInstance('job', 'k');
        const e1 = await repo.createExecution(inst.id, {});
        const e2 = await repo.createExecution(inst.id, {});
        await repo.startStep(e1.id, 'x', 1);
        expect(await repo.findStepExecutions(e2.id)).toHaveLength(0);
      });
    });

    describe('execution context', () => {
      it('loadContext is null when nothing was saved', async () => {
        expect(await repo.loadContext('JOB', 1)).toBeNull();
      });

      it('round-trips a saved context', async () => {
        await repo.saveContext('JOB', 1, { cursor: 7, tags: ['a'] });
        expect(await repo.loadContext('JOB', 1)).toEqual({ cursor: 7, tags: ['a'] });
      });

      it('separates JOB and STEP owners that share an id', async () => {
        await repo.saveContext('JOB', 1, { scope: 'job' });
        await repo.saveContext('STEP', 1, { scope: 'step' });
        expect(await repo.loadContext('JOB', 1)).toEqual({ scope: 'job' });
        expect(await repo.loadContext('STEP', 1)).toEqual({ scope: 'step' });
      });

      it('upserts: a second save overwrites the first', async () => {
        await repo.saveContext('JOB', 1, { v: 1 });
        await repo.saveContext('JOB', 1, { v: 2 });
        expect(await repo.loadContext('JOB', 1)).toEqual({ v: 2 });
      });

      it('does not alias stored state with the caller (save copies)', async () => {
        const ctx: Record<string, unknown> = { n: 1 };
        await repo.saveContext('JOB', 1, ctx);
        ctx.n = 999;
        expect(await repo.loadContext('JOB', 1)).toEqual({ n: 1 });
      });

      it('does not alias loaded state with storage (load copies)', async () => {
        await repo.saveContext('JOB', 1, { n: 1 });
        const loaded = await repo.loadContext('JOB', 1);
        expect(loaded).not.toBeNull();
        if (loaded) loaded.n = 999;
        expect(await repo.loadContext('JOB', 1)).toEqual({ n: 1 });
      });

      it('normalizes context with JSON semantics (Date becomes a string, undefined dropped)', async () => {
        await repo.saveContext('JOB', 1, {
          when: new Date('2026-06-13T00:00:00.000Z'),
          gone: undefined,
          kept: 1,
        });
        const loaded = await repo.loadContext('JOB', 1);
        expect(loaded).toEqual({ when: '2026-06-13T00:00:00.000Z', kept: 1 });
      });
    });
  });
}
