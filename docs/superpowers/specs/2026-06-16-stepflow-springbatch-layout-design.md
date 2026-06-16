# stepflow 모노레포 — Spring Batch식 최상위 레이아웃 정합 설계

> 작성일: 2026-06-16
> 상태: 설계 승인 완료 (브레인스토밍), 자율 구현 진입
> 목표: 모노레포를 spring-batch 레이아웃에 더 충실히 맞춘다 — (1) 모듈을 repo 최상위로 올리고 `stepflow-*` 접두 폴더로, (2) `@stepflow/integration` 스케줄러/트리거 모듈을 골격으로 추가, (3) `stepflow-core` 내부를 책임별 폴더로 정리. 전부 순수 추가적/리팩터로 진행하며 공개 API·publish 정체성은 불변.

## 1. 확정된 결정 (브레인스토밍)

| 항목        | 결정                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| 모듈 배치   | **repo 최상위** (`packages/` 래퍼 제거). spring-batch와 동일                                                                |
| 폴더 네이밍 | `stepflow-*` 접두 (예: `stepflow-core`). 최상위 배치라 접두가 구분 역할                                                     |
| npm 이름    | **`@stepflow/*` 유지** (옵션 1). npm scope가 Maven groupId 역할. import 문·deps·publish 정체성 불변                         |
| integration | **스케줄러/트리거 어댑터**가 목적, 지금은 **골격만**(JobTrigger seam + manualTrigger 참조 구현). 구체 cron/큐 어댑터는 후속 |
| core 분리   | **내부 폴더 정리만** (별도 publish 패키지 X). `@stepflow/core` 단일 패키지 유지                                             |
| bom         | **범위 제외** (이번에 추가 안 함)                                                                                           |

## 2. 목표 최상위 레이아웃

```
torpedo/                          (repo 루트)
├── stepflow-core/                @stepflow/core            (PUBLISH)
├── stepflow-infrastructure/      @stepflow/infrastructure  (PUBLISH)
├── stepflow-test/                @stepflow/test            (PUBLISH)
├── stepflow-integration/         @stepflow/integration     (PUBLISH, 신규·골격)
├── stepflow-samples/             @stepflow/samples         (private)
├── stepflow-docs/                @stepflow/docs            (private)
├── package.json                  "workspaces": ["stepflow-*"]
├── tsconfig.base.json            paths 값(경로)만 수정, 키 @stepflow/* 유지
├── eslint.config.js              glob packages/* → stepflow-*
├── .husky/ .prettier* ...        (경로 무관 — 무변경)
└── README / LICENSE / ...
```

- 6개 모듈을 `git mv`로 루트 이동(이력 보존). `packages/` 디렉토리 제거.
- npm 이름·`@stepflow/*` import 문·패키지 간 deps·`publishConfig`·dry-run 결과 전부 그대로.

## 3. stepflow-core 내부 구조

```
stepflow-core/src/
├── index.ts                 배럴 (export 표면 동일 — 내부 경로만 갱신)
├── types.ts                 공유 커널: ExitStatus/BatchStatus/StepContext/Step/Logger/JobParameters
├── errors.ts                JobDefinitionError
├── builder/
│   └── define-job.ts        defineJob/Job/JobBuilder/StepLocation
├── engine/
│   ├── run-job.ts           runJob/RunJobOptions/RunJobResult
│   └── listeners.ts         JobListener/JobLifecycleContext/StepInfo/StepOutcome
├── metadata/
│   ├── metadata.ts          JobInstance/JobExecution/StepExecution/StepCounts/...
│   └── job-key.ts           computeJobKey
└── repository/
    ├── job-repository.ts    JobRepository 인터페이스 + Finish* 입력
    └── in-memory.ts         InMemoryJobRepository
```

- `types.ts`·`errors.ts`는 전 하위 폴더가 쓰는 공유 커널 → src 루트 유지.
- `git mv`로 이동. 변경되는 건 **내부 상대 import 경로**(core 소스 간 + core 테스트의 `../src/*`)와 `index.ts` 배럴 경로, 그리고 `vitest.config.ts`의 coverage `exclude`(예: `src/job-repository.ts` → `src/repository/job-repository.ts`).
- 배럴 `index.ts`가 모든 걸 re-export → infra/test/integration/samples는 `@stepflow/core`만 보고 영향 0.

## 4. stepflow-integration 골격

publish 메타데이터를 갖춘 정식 패키지 스캐폴드(package.json/tsconfig/tsup/vitest/src/index.ts/test). 내용은 트리거 seam 1개 + 참조 구현 1개로 최소화.

```ts
// stepflow-integration/src/index.ts
import type { RunJobResult } from '@stepflow/core';

/** 실행 중지 핸들. */
export interface TriggerHandle {
  stop(): Promise<void>;
}

/**
 * 잡이 "언제" 실행될지를 결정하는 소스(cron, 큐 메시지, webhook).
 * 구체 어댑터(cron/SQS/BullMQ 등)는 후속 릴리스에서 추가된다.
 */
export interface JobTrigger {
  /** 수신 시작. 트리거가 발화할 때마다 `run`을 호출. 중지 핸들 반환. */
  start(run: () => Promise<RunJobResult>): Promise<TriggerHandle>;
}

/** 수동 발화 트리거(테스트·수동 운영용 최소 참조 구현). */
export interface ManualTrigger extends JobTrigger {
  /** 등록된 러너를 즉시 1회 실행. start 전이면 throw. */
  fire(): Promise<RunJobResult>;
}

export function createManualTrigger(): ManualTrigger {
  /* runner 저장 → fire 시 호출 */
}
```

- `@stepflow/integration`은 `@stepflow/core`에 의존(`RunJobResult` 타입). PUBLISH 메타데이터 구비(`publishConfig.access: public`).
- 테스트: `createManualTrigger`로 잡 러너 등록→`fire`→실행 확인, `stop` 후 `fire`→throw.
- "골격"이므로 실제 cron/큐 어댑터·실제 publish는 비범위.

## 5. 마이그레이션 메커니즘 (단계·게이트)

1. **최상위 rename**: `git mv packages/<x> stepflow-<x>` ×6, `packages/` 제거. 루트 `package.json` workspaces `packages/*`→`stepflow-*`. `tsconfig.base.json` paths 경로값 수정. 각 패키지 `vitest.config.ts`의 상대 alias(`../core/src`→`../stepflow-core/src`, `../test/src`→`../stepflow-test/src`). `eslint.config.js` glob(`packages/docs/api`→`stepflow-docs/api`, `packages/test/src/**`→`stepflow-test/src/**`, `packages/samples/**`→`stepflow-samples/**`). → 게이트.
2. **core 내부 reorg**: `git mv` 하위 폴더 생성·이동, core 소스/테스트 상대 import 갱신, `stepflow-core/vitest.config.ts` coverage exclude 경로 갱신, `index.ts` 배럴 경로 갱신. → 게이트.
3. **integration 골격**: `stepflow-integration/` 신규(§4). workspaces glob이 이미 포함. → 게이트 + 빌드 + dry-run.

각 단계 종료 게이트: `npm run check`(typecheck+lint+test) green, `npm run build` green, agent-server grep 0, git이 rename으로 인식(이력 보존).

## 6. 성공 기준

- 6개 모듈 모두 최상위 `stepflow-*` 폴더, npm 이름 `@stepflow/*` 불변, 전 패키지 typecheck·lint·test·dual빌드 green.
- `@stepflow/core` 공개 export 표면·기존 테스트 전부 불변(내부 reorg 투명).
- `@stepflow/integration` 골격: typecheck/lint/test green, dry-run 정상, `JobTrigger` seam + `manualTrigger` 동작.
- `packages/` 잔재·stale 참조 0(설정·문서·코드 어디에도 `packages/` 경로 없음).
- publish dry-run: core/infrastructure/test/integration 정상.

## 7. 비범위

- bom 모듈, 구체 cron/큐 integration 어댑터, 실제 npm publish, core를 별도 publish 패키지로 분할, retry/chunk(별도 로드맵 단계).
