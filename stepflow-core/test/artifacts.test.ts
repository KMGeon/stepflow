import { beforeEach, describe, expect, it } from 'vitest';
import { createFakePage } from '@kmgeon/stepflow-test';

import { defineJob } from '../src/builder/define-job';
import { runJob } from '../src/engine/run-job';
import { InMemoryJobRepository } from '../src/repository/in-memory';
import type { FailureArtifact } from '../src/engine/artifacts';

const noDelay = (): Promise<void> => Promise.resolve();

function failingPage() {
  return createFakePage({
    on: (): undefined => undefined,
    off: (): undefined => undefined,
    screenshot: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    content: () => Promise.resolve('<html>boom</html>'),
    url: () => 'https://example.com/fail',
  });
}

let repo: InMemoryJobRepository;
beforeEach(() => {
  repo = new InMemoryJobRepository();
});

describe('failure artifacts', () => {
  it('TC-7: captures screenshot/html/url/meta when a step throws', async () => {
    const captured: FailureArtifact[] = [];
    const job = defineJob('j')
      .step('boom', () => Promise.reject(new Error('kaboom')))
      .build();
    const result = await runJob(job, {
      page: failingPage(),
      repository: repo,
      delay: noDelay,
      artifactSink: (a) => {
        captured.push(a);
      },
      now: () => 1234,
    });
    expect(result.status).toBe('FAILED');
    expect(captured).toHaveLength(1);
    const a = captured[0];
    if (a === undefined) throw new Error('expected one captured artifact');
    expect(a.stepName).toBe('boom');
    expect(a.executionId).toBe(result.executionId);
    expect(a.error).toContain('kaboom');
    expect(a.url).toBe('https://example.com/fail');
    expect(Array.from(a.screenshot)).toEqual([1, 2, 3]);
    expect(a.html).toBe('<html>boom</html>');
    expect(a.capturedAt).toBe(1234);
  });

  it('TC-8: a step that fails after retries captures exactly once', async () => {
    const captured: FailureArtifact[] = [];
    const job = defineJob('j')
      .step('boom', () => Promise.reject(new Error('kaboom')))
      .retry('boom', { maxAttempts: 3 })
      .build();
    await runJob(job, {
      page: failingPage(),
      repository: repo,
      delay: noDelay,
      artifactSink: (a) => {
        captured.push(a);
      },
    });
    expect(captured).toHaveLength(1);
  });

  it('TC-9: a successful step captures nothing', async () => {
    const captured: FailureArtifact[] = [];
    const job = defineJob('j')
      .step('ok', () => Promise.resolve())
      .build();
    // on/off stubs required for console capture attach/detach; no screenshot/content
    // handlers: if failure capture is wrongly attempted, the fake page throws.
    await runJob(job, {
      page: createFakePage({ on: (): undefined => undefined, off: (): undefined => undefined }),
      repository: repo,
      delay: noDelay,
      artifactSink: (a) => {
        captured.push(a);
      },
    });
    expect(captured).toHaveLength(0);
  });

  it('TC-10: a throwing sink is isolated and does not change the result', async () => {
    const job = defineJob('j')
      .step('boom', () => Promise.reject(new Error('kaboom')))
      .build();
    const result = await runJob(job, {
      page: failingPage(),
      repository: repo,
      delay: noDelay,
      artifactSink: () => {
        throw new Error('sink down');
      },
    });
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('kaboom');
  });

  it('TC-11: without artifactSink the page is never captured', async () => {
    const job = defineJob('j')
      .step('boom', () => Promise.reject(new Error('kaboom')))
      .build();
    // createFakePage() with no handlers throws on any page.* call (e.g. screenshot)
    const result = await runJob(job, {
      page: createFakePage(),
      repository: repo,
      delay: noDelay,
    });
    expect(result.status).toBe('FAILED');
  });

  it('TC-12: console and pageerror lines emitted during the step are captured', async () => {
    const handlers: Record<string, (arg: unknown) => void> = {};
    const page = createFakePage({
      on: (event: string, cb: (arg: unknown) => void) => {
        handlers[event] = cb;
      },
      off: (): undefined => undefined,
      url: () => 'https://example.com/fail',
      screenshot: () => Promise.resolve(new Uint8Array()),
      content: () => Promise.resolve(''),
    });
    const captured: FailureArtifact[] = [];
    const job = defineJob('j')
      .step('boom', () => {
        // simulate the page emitting console output during the step
        handlers.console?.({ text: () => 'hello from page' });
        handlers.pageerror?.(new Error('page blew up'));
        return Promise.reject(new Error('kaboom'));
      })
      .build();
    await runJob(job, {
      page,
      repository: repo,
      delay: noDelay,
      artifactSink: (a) => {
        captured.push(a);
      },
    });
    const artifact = captured[0];
    if (artifact === undefined) throw new Error('expected one captured artifact');
    expect(artifact.consoleLogs).toEqual(['hello from page', 'page blew up']);
  });
});
