# stepflow — 설계 문서 (v0.1)

> 작성일: 2026-06-13
> 상태: 설계 합의 완료, 구현 계획(plan) 작성 대기

## 1. 한 줄 정의

**Puppeteer 브라우저 자동화 워크플로우를, 선언적 Step/Flow로 정의하고 실행이력·재시작을 MySQL에 영속화하며 돌리는 배치 런타임.**
(Spring Batch의 Job / Step / JobRepository 개념을 브라우저 RPA 도메인으로 옮긴 오픈소스 프레임워크)

## 2. 배경 / 동기

현재 `agent-server`는 Puppeteer 자동화를 다음 구조로 운영한다:

- **Job** = `sabangnet_pull`, `naver_review`, `shopify` 등 하나의 RPA 시나리오
- **Step** = `{ seqNo, name, desc }` 메타데이터 배열(`StepDef[]`), `JOB_STEPS` 레지스트리로 매핑
- 실제 실행은 각 `*.service.ts`가 담당 (메타데이터와 실행이 분리)
- watchdog 모듈이 성공률/ROI 등 실행 추적을 부분적으로 수행

이 구조를 일반화하여:
- Step 시퀀스를 **데이터가 아닌 함수형 단위 + 조건 분기 Flow**로 표준화
- 실행이력/재시작/관측성을 **JobRepository(MySQL)** 로 표준화

`agent-server`가 stepflow의 첫 소비자이자 레퍼런스 구현이 된다.

## 3. 포지셔닝 결정 (확정)

- 코어는 **Puppeteer 전용으로 고정**한다. (generic 배치가 아님)
- `StepContext`에는 항상 `page` / `browser`가 주입된다.
- 핵심 차별 가치 우선순위: **(1) 선언적 메타데이터 모델 + (2) 실행이력·재시작·관측성**.

## 4. 핵심 개념

| 개념 | 설명 | agent-server 대응 |
|---|---|---|
| **Job** | 이름이 붙은 Step 흐름(Flow) | `sabangnet_pull` |
| **Step** | `{ name, run(ctx) }` 함수형 단위 | `StepDef` + service 메서드 |
| **Flow** | Step 간 조건 전이(transition) 그래프 | (신규) |
| **JobExecution** | Job 1회 실행 인스턴스(상태/시각/에러) | watchdog 부분 기능 |
| **StepExecution** | Step 1회 실행 기록(상태/exit status) | watchdog 부분 기능 |
| **JobRepository** | 실행/Step 이력을 MySQL에 저장·조회 | 신규 |

## 5. Step 실행 계약

```ts
type ExitStatus = 'COMPLETED' | 'FAILED' | string;

type StepContext = {
  jobName: string;
  executionId: number;
  page: Page;        // Puppeteer Page (항상 주입)
  browser: Browser;  // Puppeteer Browser (항상 주입)
  shared: Record<string, unknown>; // step 간 데이터 전달
  logger: Logger;    // 인터페이스만 의존 (구현 주입)
};

type Step = {
  name: string;
  // 정상 리턴 → 'COMPLETED', throw → 'FAILED', 문자열 리턴 → 그 값이 exit status
  run: (ctx: StepContext) => Promise<void | ExitStatus>;
};
```

**exit status 규칙**
- `run`이 정상 리턴(void) → `COMPLETED`
- `run`이 throw → `FAILED`
- `run`이 문자열 리턴 → 그 문자열이 exit status (커스텀 분기용, 예: `'EMPTY'`)

## 6. Flow / 조건 분기 — 빌더 체이닝 API (확정)

```ts
const job = defineJob('order_flow')
  .start('login')
  .step('login',   { run: async (ctx) => { ... } })
  .step('collect', {
      run: async (ctx) => {
        const ok = await tryCollect(ctx.page);
        return ok ? 'COMPLETED' : 'EMPTY';
      },
  })
  .step('notify',  { run: async (ctx) => { ... } })
  .step('cleanup', { run: async (ctx) => { ... } })
  // 전이 규칙
  .on('login',   'COMPLETED').to('collect')
  .on('collect', 'COMPLETED').to('notify')   // 성공 → A
  .on('collect', 'EMPTY').to('cleanup')      // 특수 → B
  .on('collect', 'FAILED').to('cleanup')     // 실패 → B
  .build();
```

규칙:
- `.start(stepName)` 으로 진입점 지정
- `.step(name, { run })` 으로 Step 등록
- `.on(step, status).to(next)` 로 분기 전이 정의
- 매칭되는 전이가 없으면 Job 종료(해당 exit status로 종결)
- `.build()` 시 Flow 그래프 검증 (정의되지 않은 step 참조, 도달 불가 step 등 정적 검사)

## 7. 실행 엔진 동작

```ts
const result = await runJob(job, {
  repository,          // MySqlJobRepository
  browser?,            // 기존 Puppeteer Browser 주입 (없으면 launch)
  logger?,
});
```

1. JobRepository에 `JobExecution(STARTED)` 생성
2. `.start()` Step부터 실행 → 각 Step 시작/종료/exit status 기록
3. Step의 exit status로 다음 Step을 전이 규칙에서 결정
4. 더 갈 곳 없으면 `JobExecution(COMPLETED)` 종결
5. Step이 `FAILED`이고 해당 분기 전이가 없으면 `JobExecution(FAILED)`, 에러 전파
6. 브라우저: 주입받았으면 그대로 사용(소유권 호출자), 없으면 stepflow가 launch 후 종료 시 close

### 재시작

- 같은 Job을 다시 `runJob` → JobRepository에서 마지막 `FAILED` execution 조회
- 기록된 **실제 통과 경로(step_execution)** 를 복원하여, **성공한 Step은 건너뛰고 마지막 실패 Step부터** 같은 전이 규칙으로 재개
- 안 지나간 분기는 건드리지 않음 (Spring Batch restart 시맨틱과 동일)

## 8. MySQL 스키마

```sql
CREATE TABLE job_execution (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  job_name    VARCHAR(128) NOT NULL,
  status      VARCHAR(32)  NOT NULL,   -- STARTED | COMPLETED | FAILED
  started_at  DATETIME(3)  NOT NULL,
  ended_at    DATETIME(3)  NULL,
  error       TEXT         NULL,
  INDEX idx_job_name_started (job_name, started_at)
);

CREATE TABLE step_execution (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  job_execution_id  BIGINT       NOT NULL,
  step_name         VARCHAR(128) NOT NULL,
  seq_no            INT          NOT NULL,   -- 실행 순서
  status            VARCHAR(32)  NOT NULL,   -- STARTED | COMPLETED | FAILED
  exit_status       VARCHAR(64)  NULL,       -- 분기 판단/재시작 경로 복원용
  started_at        DATETIME(3)  NOT NULL,
  ended_at          DATETIME(3)  NULL,
  error             TEXT         NULL,
  INDEX idx_exec (job_execution_id),
  FOREIGN KEY (job_execution_id) REFERENCES job_execution(id)
);
```

`schema.sql` DDL 파일로 동봉. 마이그레이션 툴 의존성 없음 (사용자가 직접 적용).

### JobRepository 인터페이스

```ts
interface JobRepository {
  startJob(jobName: string): Promise<JobExecution>;
  startStep(execId: number, stepName: string, seqNo: number): Promise<StepExecution>;
  finishStep(stepExecId: number, status: string, exitStatus: string, error?: string): Promise<void>;
  finishJob(execId: number, status: string, error?: string): Promise<void>;
  findLastFailedExecution(jobName: string): Promise<JobExecution | null>;
  findStepExecutions(execId: number): Promise<StepExecution[]>;
}
```

기본 구현은 `MySqlJobRepository`. 인터페이스로 분리해 후속 버전에서 Postgres/InMemory 어댑터 추가 가능(v0.1 범위 밖).

## 9. 기술 스택

| 영역 | 선택 | 비고 |
|---|---|---|
| 언어 | TypeScript (strict) | 타입 추론이 빌더 API의 핵심 |
| 런타임 | Node.js 20+ LTS | |
| 배포 포맷 | ESM + CJS 듀얼 | |
| 브라우저 | **`puppeteer`** (dependency) | 코어 고정 (포지셔닝 B) |
| DB 드라이버 | **`mysql2`** (peerDependency) | 사용자가 커넥션 풀 주입 |
| 빌드 | `tsup` | esbuild 기반 듀얼 번들 + d.ts |
| 테스트 | `vitest` | JobRepository는 실제 MySQL 통합테스트 |
| 패키지 매니저 | **`npm`** | 단일 패키지, workspaces 불필요 |
| 린트/포맷 | eslint + prettier | |

### 의존성 철학
- 코어 런타임 의존성 최소화 (엔진/빌더/전이는 순수 TS)
- `mysql2`는 peerDependency — stepflow가 커넥션을 소유하지 않고 주입받음
- ORM(Prisma/TypeORM) 미사용 — `mysql2` prepared statement 직접 사용
- 로거는 인터페이스만 의존

### 의도적 배제 (v0.1)
- ❌ NestJS 코어 결합 (후속 `@stepflow/nestjs` 어댑터 여지만 남김)
- ❌ Postgres/InMemory 어댑터 (인터페이스만 분리, 구현은 MySQL만)
- ❌ ORM / DI 컨테이너 / 마이그레이션 툴

## 10. 패키징

- **단일 패키지 `stepflow`** (MySQL JobRepository 내장)
- 디렉터리 개략:
  - `src/core/` — defineJob 빌더, Flow 그래프, runJob 엔진, Step 계약
  - `src/repository/` — JobRepository 인터페이스 + MySqlJobRepository
  - `src/schema.sql` — DDL
  - `examples/` — agent-server Job을 stepflow로 옮긴 레퍼런스 예제

## 11. v0.1 범위 (Scope)

**포함**
- 함수형 Step 계약 + StepContext(page/browser 주입)
- 빌더 체이닝 Flow API + 조건 분기 + 정적 검증
- runJob 엔진 (브라우저 주입/자체 launch 모두)
- MySqlJobRepository + schema.sql
- 실패 Step부터 재시작
- vitest 단위/통합 테스트

**제외 (후속)**
- Postgres/InMemory 어댑터
- NestJS 어댑터 패키지
- 대시보드/관측성 UI (watchdog 이식)
- 병렬 Step / split-flow

## 12. 성공 기준

- `agent-server`의 기존 Puppeteer Job 1개(예: `sabangnet_pull`)를 stepflow로 재구현하여 동일 동작
- Step 중간 실패 후 재시작 시 성공 Step을 건너뛰고 실패 지점부터 재개됨을 통합테스트로 검증
- `npm install stepflow` 시 무거운 전이 의존성 없이 설치됨
