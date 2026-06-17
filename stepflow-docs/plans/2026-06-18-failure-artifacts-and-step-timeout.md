# 실패 아티팩트 캡처 & step 단위 타임아웃 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** stepflow 엔진에 (A) step 최종 실패 시 화면/DOM/URL/콘솔을 주입된 sink로 내보내는 실패 아티팩트 캡처와 (B) step별 시도-단위 타임아웃을 추가한다.

**Architecture:** 두 기능 모두 `@kmgeon/stepflow-core`의 엔진 실행 루프(`run-job.ts`)와 빌더(`define-job.ts`)에 외과적으로 얹는다. 타임아웃은 `.retry()`와 동형의 `.timeout()` 빌더 + attempt 루프 안에서 `Promise.race`로 구현해 기존 retry 예산과 자연 연동한다(타임아웃 = throw). 아티팩트는 step이 최종 `failed`로 판정된 직후, 엔진이 들고 있는 `page`로 캡처해 `artifactSink` 콜백에 1회 전달한다. 엔진은 fs/DB/브라우저를 소유하지 않는다(저장 위치는 소비자 결정).

**Tech Stack:** TypeScript(strict), vitest, npm workspaces 모노레포, Puppeteer(`import type`만, peerDependency). 테스트는 InMemory + `createFakePage` 더블, 실제 타이머는 주입식 scheduler로 결정화.

## Global Constraints

- **의존성 역전 유지:** core는 fs/DB를 소유하지 않고 브라우저를 launch하지 않는다. 캡처 결과는 `artifactSink`로만 내보낸다.
- **peer 타입 의존만:** `puppeteer`는 `import type`로만 참조. 런타임 `import` 추가 금지.
- **기본 동작 불변:** `artifactSink`·`.timeout()` 미사용 시 기존 `runJob` 동작/메타데이터가 동일해야 한다. 미설정 step은 `step.run(ctx)`를 기존과 동일한 경로로 직접 호출(래핑 비용 0).
- **결정적 테스트:** 실제 시간 대기 금지. 타임아웃은 주입식 `TimeoutScheduler`로, `capturedAt`은 주입식 `now`로 제어.
- **repository contract 무영향:** `JobRepository` 인터페이스/스키마/`schema.sql` 변경 없음 — 변경은 엔진·빌더 내부와 신규 타입 export에 한정.
- **검증 게이트:** 각 태스크 종료 시 `npm run -w @kmgeon/stepflow-core test` 통과. 전체 마무리 시 루트 `npm run check`(typecheck+lint+test) 녹색.
- **PR 전 changeset:** 사용자 영향 변경이므로 마지막에 `npm run changeset` 추가(minor: 신규 옵트인 기능).

---

## File Structure

| 파일                                      | 책임                                                                                    | 변경       |
| ----------------------------------------- | --------------------------------------------------------------------------------------- | ---------- |
| `stepflow-core/src/engine/timeout.ts`     | `StepTimeoutError`, `TimeoutScheduler`/`TimeoutHandle`, `realTimeout`, `runWithTimeout` | 신규       |
| `stepflow-core/src/engine/artifacts.ts`   | `FailureArtifact`, `ArtifactSink`, `captureFailureArtifact`, 콘솔 캡처 attach/detach    | 신규       |
| `stepflow-core/src/builder/define-job.ts` | `.timeout()` 등록 + `stepTimeout()` 조회 + build 검증                                   | 수정       |
| `stepflow-core/src/engine/run-job.ts`     | attempt 루프에 타임아웃 가드, 최종 실패 시 아티팩트 캡처, 신규 옵션                     | 수정       |
| `stepflow-core/src/index.ts`              | 신규 타입/값 re-export                                                                  | 수정       |
| `stepflow-core/test/timeout.test.ts`      | 타임아웃 엔진 통합 테스트                                                               | 신규       |
| `stepflow-core/test/artifacts.test.ts`    | 아티팩트 캡처 엔진 통합 테스트                                                          | 신규       |
| `stepflow-core/test/define-job.test.ts`   | `.timeout()` 빌더 검증 테스트                                                           | 수정(추가) |
| `stepflow-docs/design.md`                 | §15 로드맵에 구현 반영                                                                  | 수정       |

> `stepflow-bundle/src/index.ts`는 `export * from '@kmgeon/stepflow-core'`이므로 신규 export가 자동 전파된다 — 수정 불필요.

---

### Task 1: `.timeout()` 빌더 + 검증 + `StepTimeoutError`

**Files:**

- Create: `stepflow-core/src/engine/timeout.ts` (이 태스크에서는 `StepTimeoutError`만)
- Modify: `stepflow-core/src/builder/define-job.ts`
- Modify: `stepflow-core/src/index.ts`
- Test: `stepflow-core/test/define-job.test.ts` (추가)

**Interfaces:**

- Produces:
  - `class StepTimeoutError extends Error { readonly stepName: string; readonly timeoutMs: number }` (from `engine/timeout.ts`)
  - `JobBuilder.timeout(stepName: string, ms: number): JobBuilder`
  - `Job.stepTimeout(stepName: string): number | null`
- Consumes: 기존 `JobDefinitionError`, `Job`/`JobBuilder` 인터페이스, build 검증 패턴(`define-job.ts:94-106`의 retry 검증).

- [ ] **Step 1: `StepTimeoutError` 작성**

`stepflow-core/src/engine/timeout.ts` 생성:

```ts
/**
 * Thrown by the engine when a step exceeds its configured per-attempt timeout.
 * Surfaced as a normal thrown error so it flows through the existing retry budget
 * and is recorded as a FAILED step.
 */
export class StepTimeoutError extends Error {
  readonly stepName: string;
  readonly timeoutMs: number;
  constructor(stepName: string, timeoutMs: number) {
    super(`step "${stepName}" exceeded timeout of ${timeoutMs}ms`);
    this.name = 'StepTimeoutError';
    this.stepName = stepName;
    this.timeoutMs = timeoutMs;
  }
}
```

- [ ] **Step 2: `.timeout()` 빌더 검증 실패 테스트 작성**

`stepflow-core/test/define-job.test.ts` 파일 맨 아래에 추가(기존 import의 `defineJob`/`JobDefinitionError` 재사용; 없으면 상단 import 확인):

```ts
describe('timeout()', () => {
  it('rejects a timeout on an unknown step at build()', () => {
    expect(() =>
      defineJob('j')
        .step('a', async () => {})
        .timeout('nope', 1000)
        .build(),
    ).toThrow(JobDefinitionError);
  });

  it('rejects a timeout on a chunk step at build()', () => {
    expect(() =>
      defineJob('j')
        .chunkStep('c', {
          chunkSize: 1,
          reader: () => [1],
          writer: () => {},
        })
        .timeout('c', 1000)
        .build(),
    ).toThrow(JobDefinitionError);
  });

  it('exposes the configured timeout via stepTimeout(), null when unset', () => {
    const job = defineJob('j')
      .step('a', async () => {})
      .step('b', async () => {})
      .timeout('a', 1500)
      .build();
    expect(job.stepTimeout('a')).toBe(1500);
    expect(job.stepTimeout('b')).toBeNull();
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npm run -w @kmgeon/stepflow-core test -- define-job`
Expected: FAIL — `timeout`/`stepTimeout`이 정의되지 않음(타입/런타임 에러).

- [ ] **Step 4: 빌더에 `.timeout()` 구현**

`stepflow-core/src/builder/define-job.ts` 수정.

(a) `JobBuilder` 인터페이스에 메서드 추가 (`retry` 선언 바로 아래, line 34 부근):

```ts
  /** Attach a per-attempt timeout (ms) to a step. Exceeding it throws StepTimeoutError. */
  timeout(stepName: string, ms: number): JobBuilder;
```

(b) `Job` 인터페이스에 조회 추가 (`retryPolicy` 선언 아래, line 22 부근):

```ts
  /** Per-attempt timeout (ms) registered for a step, or `null` if it has none. */
  stepTimeout(stepName: string): number | null;
```

(c) `JobBuilderImpl`에 필드 추가 (`#retries` 아래, line 43 부근):

```ts
  readonly #timeouts = new Map<string, number>();
```

(d) `retry()` 메서드 아래에 구현 추가:

```ts
  timeout(stepName: string, ms: number): this {
    this.#timeouts.set(stepName, ms);
    return this;
  }
```

(e) `build()`의 retry 검증 루프(line 94-106) 바로 아래에 timeout 검증 추가:

```ts
for (const stepName of this.#timeouts.keys()) {
  const location = locations.get(stepName);
  if (location === undefined) {
    throw new JobDefinitionError(`Job "${this.#name}" sets timeout on unknown step "${stepName}"`);
  }
  if ('reader' in location.step) {
    throw new JobDefinitionError(
      `Job "${this.#name}" cannot set timeout on chunk step "${stepName}" (chunk steps recover via checkpoint restart)`,
    );
  }
}
```

(f) `build()`에서 frozen job 생성 직전 `const retries = new Map(...)` 옆에 추가:

```ts
const timeouts = new Map(this.#timeouts);
```

(g) 반환되는 `job` 객체에 `stepTimeout` 추가 (`retryPolicy` 메서드 아래):

```ts
      stepTimeout(stepName: string): number | null {
        return timeouts.get(stepName) ?? null;
      },
```

- [ ] **Step 5: `StepTimeoutError` export**

`stepflow-core/src/index.ts`의 retry export 줄(line 41) 아래에 추가:

```ts
export { StepTimeoutError } from './engine/timeout';
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `npm run -w @kmgeon/stepflow-core test -- define-job`
Expected: PASS (신규 3개 포함 전부 통과).

- [ ] **Step 7: 커밋**

```bash
git add stepflow-core/src/engine/timeout.ts stepflow-core/src/builder/define-job.ts stepflow-core/src/index.ts stepflow-core/test/define-job.test.ts
git commit -m "feat(core): step별 timeout 빌더 API와 build 검증 추가"
```

---

### Task 2: 타임아웃 엔진 연동 (`runWithTimeout` + attempt 루프)

**Files:**

- Modify: `stepflow-core/src/engine/timeout.ts`
- Modify: `stepflow-core/src/engine/run-job.ts`
- Modify: `stepflow-core/src/index.ts`
- Test: `stepflow-core/test/timeout.test.ts` (신규)

**Interfaces:**

- Consumes: `StepTimeoutError`(Task 1), `Job.stepTimeout()`(Task 1), 기존 `StepContext`/`StepRun`/`ExitStatus`/`COMPLETED`/`FAILED`, run-job의 retry attempt 루프(`run-job.ts:185-220`).
- Produces:
  - `interface TimeoutHandle { readonly promise: Promise<void>; cancel(): void }`
  - `type TimeoutScheduler = (ms: number) => TimeoutHandle`
  - `const realTimeout: TimeoutScheduler`
  - `function runWithTimeout(run: StepRun, ctx: StepContext, opts: { stepName: string; timeoutMs: number; scheduler: TimeoutScheduler; parentSignal?: AbortSignal }): Promise<void | ExitStatus>`
  - `RunJobOptions.timeoutScheduler?: TimeoutScheduler` (기본 `realTimeout`; 테스트 주입용)

- [ ] **Step 1: `runWithTimeout` 실패 테스트 작성**

`stepflow-core/test/timeout.test.ts` 생성:

```ts
import type { Page } from 'puppeteer';
import { beforeEach, describe, expect, it } from 'vitest';

import { defineJob } from '../src/builder/define-job';
import { runJob } from '../src/engine/run-job';
import { InMemoryJobRepository } from '../src/repository/in-memory';
import type { TimeoutScheduler } from '../src/engine/timeout';

const page = {} as unknown as Page;
const noDelay = (): Promise<void> => Promise.resolve();

/** A scheduler whose Nth handle (1-based) fires immediately; others never fire. */
function fireOnAttempt(...attempts: number[]): TimeoutScheduler {
  let n = 0;
  return () => {
    n += 1;
    if (attempts.includes(n)) {
      return { promise: Promise.resolve(), cancel: () => {} };
    }
    return { promise: new Promise<void>(() => {}), cancel: () => {} };
  };
}

const pending = (): Promise<void> => new Promise<void>(() => {});

let repo: InMemoryJobRepository;
beforeEach(() => {
  repo = new InMemoryJobRepository();
});

async function stepStatus(executionId: number, stepName: string): Promise<string | undefined> {
  const steps = await repo.findStepExecutions(executionId);
  return steps.find((s) => s.stepName === stepName)?.status;
}

describe('step timeout', () => {
  it('TC-1: a step that exceeds its timeout is recorded FAILED', async () => {
    const job = defineJob('j')
      .step('a', () => pending())
      .timeout('a', 50)
      .build();
    const result = await runJob(job, {
      page,
      repository: repo,
      delay: noDelay,
      timeoutScheduler: fireOnAttempt(1),
    });
    expect(result.status).toBe('FAILED');
    expect(await stepStatus(result.executionId, 'a')).toBe('FAILED');
  });

  it('TC-2: each retry attempt gets its own timeout (3 attempts then FAILED)', async () => {
    let calls = 0;
    const job = defineJob('j')
      .step('a', () => {
        calls += 1;
        return pending();
      })
      .timeout('a', 50)
      .retry('a', { maxAttempts: 3 })
      .build();
    const result = await runJob(job, {
      page,
      repository: repo,
      delay: noDelay,
      timeoutScheduler: fireOnAttempt(1, 2, 3),
    });
    expect(result.status).toBe('FAILED');
    expect(calls).toBe(3);
    const steps = await repo.findStepExecutions(result.executionId);
    expect(steps.find((s) => s.stepName === 'a')?.attempts).toBe(3);
  });

  it('TC-3: timeout on attempt 1, success on attempt 2 -> COMPLETED', async () => {
    let calls = 0;
    const job = defineJob('j')
      .step('a', () => {
        calls += 1;
        return calls === 1 ? pending() : Promise.resolve();
      })
      .timeout('a', 50)
      .retry('a', { maxAttempts: 3 })
      .build();
    const result = await runJob(job, {
      page,
      repository: repo,
      delay: noDelay,
      timeoutScheduler: fireOnAttempt(1),
    });
    expect(result.status).toBe('COMPLETED');
    expect(calls).toBe(2);
  });

  it('TC-4: on timeout the step-facing signal is aborted', async () => {
    let aborted: boolean | undefined;
    const job = defineJob('j')
      .step('a', (ctx) => {
        // record after the engine aborts; pending keeps the attempt open until timeout fires
        return new Promise<void>(() => {
          ctx.signal?.addEventListener('abort', () => {
            aborted = true;
          });
        });
      })
      .timeout('a', 50)
      .build();
    await runJob(job, {
      page,
      repository: repo,
      delay: noDelay,
      timeoutScheduler: fireOnAttempt(1),
    });
    expect(aborted).toBe(true);
  });

  it('TC-5: a step without a timeout is unaffected', async () => {
    let ran = false;
    const job = defineJob('j')
      .step('a', async () => {
        ran = true;
      })
      .build();
    const result = await runJob(job, { page, repository: repo, delay: noDelay });
    expect(result.status).toBe('COMPLETED');
    expect(ran).toBe(true);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm run -w @kmgeon/stepflow-core test -- timeout`
Expected: FAIL — `timeoutScheduler` 옵션과 `runWithTimeout`이 없어 타임아웃이 발화되지 않음(TC-1~4 실패).

- [ ] **Step 3: `timeout.ts`에 scheduler + `runWithTimeout` 구현**

`stepflow-core/src/engine/timeout.ts`에 `StepTimeoutError` 아래로 추가:

```ts
import type { ExitStatus, StepContext, StepRun } from '../types';

/** A pending timeout: `promise` resolves when the deadline elapses; `cancel` stops it. */
export interface TimeoutHandle {
  readonly promise: Promise<void>;
  cancel(): void;
}

/** Schedules a deadline. Injectable so tests need not wait real time. */
export type TimeoutScheduler = (ms: number) => TimeoutHandle;

/** Default scheduler backed by `setTimeout`. */
export const realTimeout: TimeoutScheduler = (ms) => {
  let id: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    id = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      if (id !== undefined) clearTimeout(id);
    },
  };
};

/**
 * Run a step under a per-attempt deadline. Races the step against the scheduled
 * timeout; on timeout it aborts a child AbortSignal (linked to the caller's
 * signal) so the step can cancel cooperatively, then throws StepTimeoutError.
 * The engine never force-closes the page — that stays the caller's responsibility.
 */
export async function runWithTimeout(
  run: StepRun,
  ctx: StepContext,
  opts: {
    stepName: string;
    timeoutMs: number;
    scheduler: TimeoutScheduler;
    parentSignal?: AbortSignal;
  },
): Promise<void | ExitStatus> {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  if (opts.parentSignal !== undefined) {
    if (opts.parentSignal.aborted) controller.abort();
    else opts.parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const childCtx: StepContext = { ...ctx, signal: controller.signal };
  const timer = opts.scheduler(opts.timeoutMs);
  try {
    return await Promise.race([
      run(childCtx),
      timer.promise.then((): never => {
        throw new StepTimeoutError(opts.stepName, opts.timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof StepTimeoutError) controller.abort();
    throw error;
  } finally {
    timer.cancel();
    opts.parentSignal?.removeEventListener('abort', onParentAbort);
  }
}
```

- [ ] **Step 4: `run-job.ts`에 옵션과 attempt 루프 연동**

(a) import 추가 (line 10-11 부근, retry import 옆):

```ts
import { realTimeout, runWithTimeout } from './timeout';
import type { TimeoutScheduler } from './timeout';
```

(b) `RunJobOptions`에 필드 추가 (`delay` 아래, line 39 부근):

```ts
  /** Override the timeout scheduler (e.g. a controllable one in tests). Defaults to setTimeout-backed. */
  readonly timeoutScheduler?: TimeoutScheduler;
```

(c) 옵션 구조분해 영역(line 92-97 부근)에 추가:

```ts
const timeoutScheduler = options.timeoutScheduler ?? realTimeout;
```

(d) attempt 루프 안의 `const returned = await step.run(ctx);` (line 191)를 교체:

```ts
const timeoutMs = job.stepTimeout(step.name);
const returned =
  timeoutMs === null
    ? await step.run(ctx)
    : await runWithTimeout(step.run, ctx, {
        stepName: step.name,
        timeoutMs,
        scheduler: timeoutScheduler,
        parentSignal: options.signal,
      });
```

> `timeoutMs`는 attempt마다 다시 읽히지만 step별 상수이므로 무해하며, 미설정(`null`)이면 기존과 완전히 동일한 `step.run(ctx)` 경로를 탄다(Global Constraints: 기본 동작 불변).

- [ ] **Step 5: 타입 export 추가**

`stepflow-core/src/index.ts`의 Task 1에서 추가한 `StepTimeoutError` export 줄을 다음으로 확장:

```ts
export { StepTimeoutError } from './engine/timeout';
export type { TimeoutScheduler, TimeoutHandle } from './engine/timeout';
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `npm run -w @kmgeon/stepflow-core test -- timeout`
Expected: PASS (TC-1~5 전부).

- [ ] **Step 7: 회귀 확인 + 커밋**

Run: `npm run -w @kmgeon/stepflow-core test`
Expected: PASS (기존 전체 + 신규).

```bash
git add stepflow-core/src/engine/timeout.ts stepflow-core/src/engine/run-job.ts stepflow-core/src/index.ts stepflow-core/test/timeout.test.ts
git commit -m "feat(core): step별 시도-단위 타임아웃 엔진 연동"
```

---

### Task 3: 실패 아티팩트 캡처 (`artifactSink`)

**Files:**

- Create: `stepflow-core/src/engine/artifacts.ts`
- Modify: `stepflow-core/src/engine/run-job.ts`
- Modify: `stepflow-core/src/index.ts`
- Test: `stepflow-core/test/artifacts.test.ts` (신규)

**Interfaces:**

- Consumes: 기존 `page`(`StepContext.page`/run-job 지역), run-job의 최종 실패 분기(`run-job.ts:242-247`의 `if (failed)` 블록), `Logger`.
- Produces:
  - `interface FailureArtifact { jobName; executionId; stepName; seqNo; error; url; screenshot: Uint8Array; html: string; consoleLogs: readonly string[]; capturedAt: number }`
  - `type ArtifactSink = (artifact: FailureArtifact) => void | Promise<void>`
  - `function captureFailureArtifact(page, meta, consoleLogs, now): Promise<FailureArtifact>`
  - `RunJobOptions.artifactSink?: ArtifactSink`, `RunJobOptions.now?: () => number`

- [ ] **Step 1: 캡처 실패 테스트 작성**

`stepflow-core/test/artifacts.test.ts` 생성:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createFakePage } from '@kmgeon/stepflow-test';

import { defineJob } from '../src/builder/define-job';
import { runJob } from '../src/engine/run-job';
import { InMemoryJobRepository } from '../src/repository/in-memory';
import type { FailureArtifact } from '../src/engine/artifacts';

const noDelay = (): Promise<void> => Promise.resolve();

function failingPage() {
  return createFakePage({
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
    const a = captured[0]!;
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
      .step('ok', async () => {})
      .build();
    // no screenshot/content handlers: if capture is wrongly attempted, the fake page throws
    await runJob(job, {
      page: createFakePage(),
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
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm run -w @kmgeon/stepflow-core test -- artifacts`
Expected: FAIL — `artifactSink`/`now` 옵션과 `FailureArtifact`가 없음.

- [ ] **Step 3: `artifacts.ts` 작성**

`stepflow-core/src/engine/artifacts.ts` 생성:

```ts
import type { Page } from 'puppeteer';

/** A snapshot captured when a step finally fails, handed to {@link ArtifactSink}. */
export interface FailureArtifact {
  readonly jobName: string;
  readonly executionId: number;
  readonly stepName: string;
  /** 1-based sequence number of the step in the job definition. */
  readonly seqNo: number;
  readonly error: string;
  readonly url: string;
  /** PNG bytes from `page.screenshot()`; empty if the capture failed. */
  readonly screenshot: Uint8Array;
  /** `page.content()` DOM dump; empty string if the capture failed. */
  readonly html: string;
  /** Console/page-error lines collected during the step (empty until console capture lands). */
  readonly consoleLogs: readonly string[];
  /** epoch ms when captured. */
  readonly capturedAt: number;
}

/** Receives a failure artifact. The consumer owns storage (file/S3/DB). */
export type ArtifactSink = (artifact: FailureArtifact) => void | Promise<void>;

/** Metadata the engine knows about the failing step, merged into the artifact. */
export interface FailureArtifactMeta {
  readonly jobName: string;
  readonly executionId: number;
  readonly stepName: string;
  readonly seqNo: number;
  readonly error: string;
}

/**
 * Best-effort capture: each of screenshot/html/url is independent, so a failure
 * in one still yields the others. Never throws — capture must not mask the
 * original step failure.
 */
export async function captureFailureArtifact(
  page: Page,
  meta: FailureArtifactMeta,
  consoleLogs: readonly string[],
  now: () => number,
): Promise<FailureArtifact> {
  let url = '';
  let screenshot = new Uint8Array();
  let html = '';
  try {
    url = page.url();
  } catch {
    /* best-effort */
  }
  try {
    screenshot = (await page.screenshot()) as Uint8Array;
  } catch {
    /* best-effort */
  }
  try {
    html = await page.content();
  } catch {
    /* best-effort */
  }
  return { ...meta, url, screenshot, html, consoleLogs, capturedAt: now() };
}
```

> 참고: `page.screenshot()`은 Puppeteer 버전에 따라 `Buffer`(`Uint8Array` 서브클래스)를 반환하므로 `as Uint8Array`로 좁힌다.

- [ ] **Step 4: `run-job.ts`에 옵션과 캡처 호출 연동**

(a) import 추가:

```ts
import { captureFailureArtifact } from './artifacts';
import type { ArtifactSink } from './artifacts';
```

(b) `RunJobOptions`에 필드 추가:

```ts
  /** Invoked once when a step finally fails, with a page snapshot. Storage is the consumer's. */
  readonly artifactSink?: ArtifactSink;
  /** Clock for `capturedAt` (injectable for deterministic tests). Defaults to `Date.now`. */
  readonly now?: () => number;
```

(c) 옵션 구조분해 영역에 추가:

```ts
const artifactSink = options.artifactSink;
const now = options.now ?? ((): number => Date.now());
```

(d) 최종 실패 분기(`if (failed)` 블록, line 242-247 — `onStepError` notify 호출 **직전**)에 삽입:

```ts
if (artifactSink !== undefined) {
  const artifact = await captureFailureArtifact(
    page,
    {
      jobName: job.name,
      executionId: execution.id,
      stepName: step.name,
      seqNo,
      error: errorMessage ?? `step "${step.name}" returned exit status "${exitStatus}"`,
    },
    [],
    now,
  );
  try {
    await artifactSink(artifact);
  } catch (sinkError) {
    const message = sinkError instanceof Error ? sinkError.message : String(sinkError);
    logger.error('artifactSink threw', { error: message });
  }
}
```

> 이 블록은 `failed === true`일 때만 도는 기존 분기 안에 있으므로, retry로 복구된 step이나 성공 step에서는 실행되지 않는다(TC-8/TC-9). `consoleLogs`는 Task 4에서 실제 값으로 대체될 자리표시 `[]`다.

- [ ] **Step 5: 타입 export 추가**

`stepflow-core/src/index.ts`의 timeout export 줄들 아래에 추가:

```ts
export type { FailureArtifact, ArtifactSink } from './engine/artifacts';
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `npm run -w @kmgeon/stepflow-core test -- artifacts`
Expected: PASS (TC-7~11).

- [ ] **Step 7: 회귀 확인 + 커밋**

Run: `npm run -w @kmgeon/stepflow-core test`
Expected: PASS (전체).

```bash
git add stepflow-core/src/engine/artifacts.ts stepflow-core/src/engine/run-job.ts stepflow-core/src/index.ts stepflow-core/test/artifacts.test.ts
git commit -m "feat(core): step 최종 실패 시 아티팩트 캡처 sink 추가"
```

---

### Task 4: 콘솔 로그 수집 (FR-6, SHOULD)

> 이 태스크는 독립적으로 승인/보류 가능하다. 보류하면 `consoleLogs`는 빈 배열로 남고 나머지 아티팩트는 정상 동작한다.

**Files:**

- Modify: `stepflow-core/src/engine/artifacts.ts`
- Modify: `stepflow-core/src/engine/run-job.ts`
- Test: `stepflow-core/test/artifacts.test.ts` (추가)

**Interfaces:**

- Consumes: `captureFailureArtifact`(Task 3), `page.on`/`page.off`(Puppeteer), run-job의 attempt 루프 진입/이탈 지점.
- Produces: `function attachConsoleCapture(page: Page): { logs: string[]; detach(): void }` (from `artifacts.ts`).

- [ ] **Step 1: 콘솔 캡처 테스트 작성**

`stepflow-core/test/artifacts.test.ts`의 `describe` 안에 추가:

```ts
it('TC-12: console and pageerror lines emitted during the step are captured', async () => {
  const handlers: Record<string, (arg: unknown) => void> = {};
  const page = createFakePage({
    on: (event: string, cb: (arg: unknown) => void) => {
      handlers[event] = cb;
    },
    off: () => {},
    url: () => 'https://example.com/fail',
    screenshot: () => Promise.resolve(new Uint8Array()),
    content: () => Promise.resolve(''),
  });
  const captured: FailureArtifact[] = [];
  const job = defineJob('j')
    .step('boom', () => {
      // simulate the page emitting console output during the step
      handlers['console']?.({ text: () => 'hello from page' });
      handlers['pageerror']?.(new Error('page blew up'));
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
  expect(captured[0]!.consoleLogs).toEqual(['hello from page', 'page blew up']);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm run -w @kmgeon/stepflow-core test -- artifacts`
Expected: FAIL — `consoleLogs`가 `[]`라 `['hello from page', 'page blew up']`와 불일치.

- [ ] **Step 3: `attachConsoleCapture` 구현**

`stepflow-core/src/engine/artifacts.ts`에 추가:

```ts
/** A Puppeteer ConsoleMessage exposes `text()`; we only need that here. */
interface ConsoleLike {
  text(): string;
}

/**
 * Subscribe to a page's `console`/`pageerror` events and buffer their text.
 * Returns the live buffer and a `detach` to unsubscribe at step end.
 */
export function attachConsoleCapture(page: Page): { logs: string[]; detach(): void } {
  const logs: string[] = [];
  const onConsole = (msg: ConsoleLike): void => {
    logs.push(msg.text());
  };
  const onPageError = (err: Error): void => {
    logs.push(err.message);
  };
  // Puppeteer's typed overloads don't accept a bare string here; the page double
  // and runtime both key off the event name, so cast through a minimal shape.
  const emitter = page as unknown as {
    on(event: string, cb: (arg: never) => void): void;
    off(event: string, cb: (arg: never) => void): void;
  };
  emitter.on('console', onConsole as (arg: never) => void);
  emitter.on('pageerror', onPageError as (arg: never) => void);
  return {
    logs,
    detach: () => {
      emitter.off('console', onConsole as (arg: never) => void);
      emitter.off('pageerror', onPageError as (arg: never) => void);
    },
  };
}
```

- [ ] **Step 4: run-job에서 attach/detach + 캡처에 전달**

(a) import에 추가:

```ts
import { attachConsoleCapture, captureFailureArtifact } from './artifacts';
```

(b) step 처리 시작부(`const stepExecution = await repository.startStep(...)` 직후, attempt 루프 **이전**)에 추가:

```ts
const consoleCapture = artifactSink !== undefined ? attachConsoleCapture(page) : null;
```

(c) Task 3에서 넣은 캡처 호출의 `[]` 인자를 교체:

```ts
          consoleCapture?.logs ?? [],
```

(d) step 처리가 끝나고 다음 step으로 넘어가기 전(루프 본문 끝, `afterStep` notify 이후)에서 detach:

```ts
consoleCapture?.detach();
```

> attach는 step당 1회(모든 attempt 공유)이므로 재시도 간 콘솔 로그가 누적된다 — 의도된 동작(전체 시도의 콘솔을 남긴다).

- [ ] **Step 5: 테스트 통과 확인**

Run: `npm run -w @kmgeon/stepflow-core test -- artifacts`
Expected: PASS (TC-7~12).

- [ ] **Step 6: 회귀 확인 + 커밋**

Run: `npm run -w @kmgeon/stepflow-core test`
Expected: PASS.

```bash
git add stepflow-core/src/engine/artifacts.ts stepflow-core/src/engine/run-job.ts stepflow-core/test/artifacts.test.ts
git commit -m "feat(core): 실패 아티팩트에 콘솔 로그 수집 추가"
```

---

### Task 5: 전체 검증 · 문서 · changeset

**Files:**

- Modify: `stepflow-docs/design.md`
- Create: `.changeset/<생성됨>.md`

**Interfaces:**

- Consumes: Task 1~4 전체.

- [ ] **Step 1: 루트 전체 게이트 통과 확인**

Run: `npm run check`
Expected: typecheck + lint + test 전 워크스페이스 PASS. 실패하면 해당 워크스페이스를 고치고 재실행.

- [ ] **Step 2: design.md 로드맵 갱신**

`stepflow-docs/design.md` §15 로드맵 표에서 v0.2 행의 "retry/recovery (백오프 + 실패 아티팩트: 스크린샷/HTML)" 항목이 구현되었음을 반영하도록 수정한다. v0.2 행 내용을 다음으로 교체:

```
| **v0.2**        | retry/recovery (백오프) ✅ · 실패 아티팩트(스크린샷/HTML/URL/콘솔 → `artifactSink`) ✅ · step 시도-단위 타임아웃(`.timeout()`) ✅ · listeners ✅ · 파라미터 검증/incrementer |
```

- [ ] **Step 3: changeset 추가**

Run: `npm run changeset`

- 대상 패키지: `@kmgeon/stepflow-core` 선택 (엄브렐러/infra는 internal dependency 규칙으로 함께 bump)
- 변경 종류: **minor** (신규 옵트인 기능, 호환 유지)
- 요약: `step별 timeout(.timeout())과 실패 아티팩트 캡처(artifactSink) 추가`

- [ ] **Step 4: 커밋**

```bash
git add stepflow-docs/design.md .changeset
git commit -m "docs(core): 타임아웃·아티팩트 로드맵 반영 및 changeset 추가"
```

---

## Self-Review

**1. Spec coverage (PRD → 태스크 매핑):**

| PRD 요구                           | 태스크                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------- |
| FR-1 sink 콜백 주입                | Task 3 (Step 4 `artifactSink`)                                         |
| FR-2 캡처 대상(스샷/HTML/URL/콘솔) | Task 3 (스샷/HTML/URL) + Task 4 (콘솔)                                 |
| FR-3 최종 실패만 트리거            | Task 3 (`if (failed)` 분기 내 호출, TC-8)                              |
| FR-4 아티팩트 메타                 | Task 3 (`FailureArtifactMeta`/`FailureArtifact`)                       |
| FR-5 캡처 격리                     | Task 3 (sink try/catch, TC-10) + `captureFailureArtifact` never-throws |
| FR-6 콘솔 로그                     | Task 4                                                                 |
| FR-7 미주입 시 무동작              | Task 3 (`artifactSink !== undefined` 가드, TC-11)                      |
| FR-8 `.timeout()` 선언 + 검증      | Task 1                                                                 |
| FR-9 시도별 타임아웃               | Task 2 (attempt 루프 내 `runWithTimeout`, TC-2)                        |
| FR-10 초과 = throw                 | Task 2 (`StepTimeoutError`, TC-1)                                      |
| FR-11 reject + signal abort        | Task 2 (`runWithTimeout` controller, TC-4)                             |
| FR-12 chunk step 제외              | Task 1 (build 검증, define-job 테스트)                                 |
| FR-13 미설정 시 무제한             | Task 2 (`timeoutMs === null` → 직접 호출, TC-5)                        |
| NFR-1~5                            | Global Constraints + Task 2/3 기본 경로 분기                           |

누락 없음.

**2. Placeholder scan:** "TBD"/"적절히 처리"/"위와 유사" 류 없음. 모든 코드 step에 실제 코드 포함. `consoleLogs: []`는 Task 3의 의도된 자리표시이며 Task 4에서 대체됨을 명시함.

**3. Type consistency:** `runWithTimeout`/`TimeoutScheduler`/`TimeoutHandle`/`StepTimeoutError`/`captureFailureArtifact`/`FailureArtifact`/`FailureArtifactMeta`/`ArtifactSink`/`attachConsoleCapture`/`Job.stepTimeout`/`JobBuilder.timeout` 시그니처가 정의 태스크와 소비 태스크 전반에서 일치. `RunJobOptions` 신규 필드(`timeoutScheduler`/`artifactSink`/`now`)는 각각 정의된 태스크에서 추가되고 이후 테스트에서 동일 이름으로 사용됨.
