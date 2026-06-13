# stepflow — 설계 문서 (v0.2)

> 작성일: 2026-06-13
> 상태: 설계 합의 완료(v0.2), 구현 계획(plan) 작성 대기
> 변경: v0.1 → v0.2 (오써링 API, Puppeteer 바인딩, 메타데이터 스키마, 파라미터/restart, 테스트 전략) — 자세한 내역은 §17

## 1. 한 줄 정의

**주입된 Puppeteer `page` 위에서 선언적 Step/Flow를 실행하고, Spring Batch 충실 메타데이터(JobInstance / JobExecution / ExecutionContext)를 MySQL에 영속화하며, 파라미터 인스턴스 단위로 실패 지점부터 재시작하는 브라우저 RPA 배치 런타임.**
(Spring Batch의 Job / Step / JobRepository / JobInstance 개념을 브라우저 RPA 도메인으로 옮긴 오픈소스 프레임워크)

## 2. 배경 / 동기

현재 `agent-server`는 Puppeteer 자동화를 다음 구조로 운영한다:

- **Job** = `sabangnet_pull`, `naver_review`, `shopify` 등 하나의 RPA 시나리오
- **Step** = `{ seqNo, name, desc }` 메타데이터 배열(`StepDef[]`), `JOB_STEPS` 레지스트리로 매핑
- 실제 실행은 각 `*.service.ts`가 담당하고, `watchdogService.runStep()`이 step을 감싼다 (메타데이터와 실행이 분리)
- watchdog 모듈이 실행 이력(`watchdog_job_history`)·성공률·이상탐지를 부분적으로 수행

이미 있는 것: 메타데이터·실행이력·실패 step 기록·관측(WebSocket).
없는 것: **재시도(retry)·체크포인트 재시작·chunk 처리·item 리스너·트랜잭션·파티셔닝.**

이 구조를 일반화하여:
- Step 시퀀스를 **데이터가 아닌 함수형 단위 + 조건 분기 Flow**로 표준화
- 실행이력/재시작/관측성을 **JobRepository(MySQL)** 로 표준화

`agent-server`가 stepflow의 첫 소비자이자 레퍼런스 구현이 된다.

## 3. 포지셔닝 결정 (확정)

- 코어는 **Puppeteer 전용으로 고정**한다. (generic 배치가 아님)
- **stepflow는 브라우저를 launch하지 않는다.** 소비자가 `browser`/`page`를 소유하고 주입한다(BYO). `StepContext`에는 항상 `page`가 주입되고, `browser`는 옵션(2탭/멀티페이지용).
- `puppeteer`는 **peerDependency**(타입 의존만). 직렬 큐·스텔스·프로필·브라우저 수명은 전부 소비자(`BrowserService`) 소관.
- 핵심 차별 가치 우선순위: **(1) 선언적 메타데이터 모델 + (2) 실행이력·재시작·관측성**.

## 4. 핵심 개념

| 개념 | 설명 | agent-server 대응 |
|---|---|---|
| **Job** | 이름이 붙은 Step 흐름(Flow) 정의 | `sabangnet_pull` |
| **JobParameters** | 실행 파라미터(날짜·스토어ID 등). 식별 파라미터는 인스턴스 정체성에 포함 | (신규) |
| **JobInstance** | `(jobName + 식별 params 해시)` 로 식별되는 논리적 실행 단위 | (신규) |
| **Step** | `{ name, run(ctx) }` 함수형 단위 | `StepDef` + service 메서드 |
| **Flow** | Step 간 조건 전이(transition) 그래프 (선형 기본 + 분기 예외) | (신규) |
| **JobExecution** | JobInstance의 1회 실행(상태/시각/에러/결과) | watchdog 부분 기능 |
| **StepExecution** | Step 1회 실행 기록(상태/exit status/카운트) | watchdog 부분 기능 |
| **ExecutionContext** | Job/Step 레벨의 영속 key-value (restart 재개 상태) | (신규) |
| **JobRepository** | 위 메타데이터를 저장·조회 (MySQL / InMemory) | 신규 |

## 5. 오써링 API — 선형 기본 + 분기 예외 (확정)

```ts
const job = defineJob('sabangnet_pull')
  .step('login',   async (ctx) => { await ctx.page.goto(URL); /* ... */ })
  .step('search',  async (ctx) => { /* ctx.params.date 사용 */ })
  .step('parse',   async (ctx) => ctx.shared.rows?.length ? 'COMPLETED' : 'EMPTY')
  .step('confirm', async (ctx) => { /* ... */ })
  .step('cleanup', async (ctx) => { /* ... */ })
  .branch('parse', { EMPTY: 'cleanup' })   // 선형 외 분기만 예외 선언
  .build();                                 // 그래프·도달성·restart 정적 검증
```

규칙:
- `.step(name, run)` 등록 순서 = **기본 선형 전이** (`COMPLETED` → 다음 step). 진입점은 첫 `.step`
- `.branch(step, { exitStatus: target })` 로 분기만 덮어씀. 매칭되는 전이가 없으면 그 exit status로 Job 종료
- `.build()` 시 Flow 그래프 정적 검증: 미정의 step 참조, 도달 불가 step, 잘못된 분기 타겟 등

> v0.1의 `.start()` + 명시적 `.on(step, status).to(next)` 빌더 대비, 흔한 선형 잡의 boilerplate를 없애고 분기 표현력은 유지한다.

## 6. Step 실행 계약 / StepContext

```ts
type ExitStatus = 'COMPLETED' | 'FAILED' | (string & {});

interface StepContext {
  jobName: string;
  instanceId: number;     // JobInstance id (jobName + 식별 params 해시)
  executionId: number;    // 이번 JobExecution id
  params: Readonly<Record<string, string>>;   // JobParameters
  page: Page;             // Puppeteer Page (항상 주입)
  browser?: Browser;      // Puppeteer Browser (2탭/멀티페이지용, 옵션)
  shared: Record<string, unknown>; // job-level ExecutionContext (영속·restart 복원)
  logger: Logger;         // 인터페이스만 의존 (구현 주입)
}

interface Step {
  name: string;
  // 정상 리턴 → 'COMPLETED', throw → 'FAILED', 문자열 리턴 → 그 값이 exit status
  run: (ctx: StepContext) => Promise<void | ExitStatus>;
}
```

**exit status 규칙**
- `run`이 정상 리턴(void) → `COMPLETED`
- `run`이 throw → `FAILED`
- `run`이 문자열 리턴 → 그 문자열이 exit status (커스텀 분기용, 예: `'EMPTY'`)

**`shared` 의미**: step 간 데이터 전달 채널이자 **job-level ExecutionContext**. step 경계마다 `execution_context`에 스냅샷되고, restart 시 복원된다 (§8, §9).

## 7. 실행 엔진 진입점

```ts
const result = await runJob(job, {
  params: { date: '2026-06-13', storeId: 'A' },  // JobParameters (식별 파라미터)
  page,                  // 필수 — 소비자가 소유 (stepflow는 launch 안 함)
  browser,               // 옵션 (2탭/멀티페이지)
  repository,            // JobRepository (MySql / InMemory)
  logger,                // 옵션 (기본 no-op)
  restart,               // 옵션 (기본 true: FAILED 직전 실행 자동 재개. false면 항상 fresh)
});
// result: { instanceId, executionId, status, exitStatus, restarted }
```

## 8. 엔진 동작 + 재시작

1. **인스턴스 해석**: `job_key = hash(jobName + identifying params)` → `job_instance` upsert
2. **재실행 판정**: 이 인스턴스의 마지막 `JobExecution` 상태로 분기 (아래 표)
3. **항상 새 `JobExecution(STARTED)` 생성** (Spring Batch와 동일 — 인스턴스당 실행이 누적됨).
   restart 모드면 직전 `FAILED` 실행에서 `step_execution` 통과 경로 + `execution_context`(`shared`)를 **읽어 새 실행에 시드**한다 (직전 실행 row는 수정하지 않음)
4. 진입 step부터 실행 (restart면 마지막 실패 step부터). 각 step:
   - `startStep` → `run(ctx)` → exit status 판정 → `finishStep`(상태/exit/duration/카운트)
   - **`shared` 스냅샷을 `execution_context`에 영속** (restart 정합성의 핵심)
   - restart 모드에서 직전 `COMPLETED` step은 실행하지 않고 건너뜀 (시드된 `shared` 사용). 안 지나간 분기는 건드리지 않음
5. 다음 step: 선형 기본 or `.branch` 매핑. 더 갈 곳 없으면 종료
6. step이 `FAILED`이고 해당 분기 전이가 없으면 `JobExecution(FAILED)`, 에러 전파
7. 완주 시 `JobExecution(COMPLETED)`

### 재실행 판정 규칙 (RPA 도메인 조정)

| 직전 실행 상태 | 기본 동작 | 비고 |
|---|---|---|
| 없음 | 신규 fresh 실행 | 첫 실행 |
| `FAILED` | **restart** (실패 step부터 재개) | `shared`/경로 복원 |
| `COMPLETED` | **신규 fresh 실행** (처음부터) | ⚠️ Spring Batch-strict는 "완료 인스턴스 재실행 불가"지만, **stepflow는 cron 재실행을 위해 허용** |

- `runJob(job, { ..., restart: false })` → FAILED여도 restart 안 하고 fresh 실행 (강제 새 시작)
- "매 실행을 항상 별개 인스턴스로" 원하면, 식별 파라미터에 timestamp/run-id를 넣는다 (Spring Batch incrementer 패턴 — v0.2에서 헬퍼 제공)
- 즉 **식별 파라미터가 같으면 같은 인스턴스에 실행이 누적**되고, FAILED 직후 재호출만 restart로 이어진다

### ⚠️ 도메인 함정 — 살아있는 브라우저 세션은 복원되지 않는다

`shared`(직렬화 가능한 데이터)는 restart 시 복원되지만, **로그인 세션·쿠키 같은 `page` 런타임 상태는 새 브라우저에서 사라진다.** Spring Batch에는 없는 RPA 특유의 한계다. 따라서 restart는 *"완전 무상태 재개"* 가 아니라 **"데이터 재개 + 세션 재확립"** 모델이다.

완화책:
- 소비자의 `BrowserService`가 **영속 Chrome 프로필**을 쓰면 세션이 유지되어 `login` step도 건너뛸 수 있음
- 그렇지 않으면, restart 시 `login` step은 다시 타도록 Flow를 설계 (예: 세션 확인 후 분기)

이 한계는 문서·예제에 명시한다.

## 9. MySQL 스키마 (L3 — Batch 충실)

```sql
CREATE TABLE job_instance (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  job_name    VARCHAR(128) NOT NULL,
  job_key     CHAR(64)     NOT NULL,            -- hash(jobName + 식별 params)
  created_at  DATETIME(3)  NOT NULL,
  UNIQUE KEY uq_instance (job_name, job_key)
);

CREATE TABLE job_execution (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  instance_id     BIGINT       NOT NULL,
  status          VARCHAR(32)  NOT NULL,        -- STARTED | COMPLETED | FAILED
  exit_status     VARCHAR(64)  NULL,
  started_at      DATETIME(3)  NOT NULL,
  ended_at        DATETIME(3)  NULL,
  duration_ms     INT          NULL,
  error           TEXT         NULL,
  items_collected INT          NULL,            -- L2: 결과 메트릭
  result_meta     JSON         NULL,            -- L2: job별 결과 메타
  INDEX idx_instance (instance_id),
  FOREIGN KEY (instance_id) REFERENCES job_instance(id)
);

CREATE TABLE job_execution_params (
  execution_id  BIGINT        NOT NULL,
  param_key     VARCHAR(128)  NOT NULL,
  param_value   VARCHAR(1024) NULL,
  identifying   TINYINT(1)    NOT NULL DEFAULT 1, -- job_key 계산에 포함되는가
  PRIMARY KEY (execution_id, param_key),
  FOREIGN KEY (execution_id) REFERENCES job_execution(id)
);

CREATE TABLE step_execution (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  job_execution_id  BIGINT       NOT NULL,
  step_name         VARCHAR(128) NOT NULL,
  seq_no            INT          NOT NULL,       -- 실행 순서
  status            VARCHAR(32)  NOT NULL,       -- STARTED | COMPLETED | FAILED
  exit_status       VARCHAR(64)  NULL,           -- 분기 판단/재시작 경로 복원용
  started_at        DATETIME(3)  NOT NULL,
  ended_at          DATETIME(3)  NULL,
  duration_ms       INT          NULL,           -- L2
  read_count        INT          NOT NULL DEFAULT 0,  -- L2 (chunk 대비, v0.1엔 0)
  write_count       INT          NOT NULL DEFAULT 0,  -- L2
  skip_count        INT          NOT NULL DEFAULT 0,  -- L2
  error             TEXT         NULL,
  INDEX idx_exec (job_execution_id),
  FOREIGN KEY (job_execution_id) REFERENCES job_execution(id)
);

CREATE TABLE execution_context (
  owner_type  VARCHAR(16) NOT NULL,             -- 'JOB' | 'STEP'
  owner_id    BIGINT      NOT NULL,             -- job_execution.id 또는 step_execution.id
  ctx         JSON        NOT NULL,             -- 직렬화된 ExecutionContext(shared)
  updated_at  DATETIME(3) NOT NULL,
  PRIMARY KEY (owner_type, owner_id)
);
```

`schema.sql` DDL 파일로 동봉. 마이그레이션 툴 의존성 없음 (사용자가 직접 적용).

> **점진 채움 전략**: v0.1 엔진은 L1(상태/시각/에러/exit_status) + L2(duration/result_meta/items_collected) 를 채우고, L3(instance 식별·params·`execution_context`)는 **restart에 실제로 사용**한다. `read/write/skip_count`는 컬럼만 존재하고 v0.1엔 0 — v0.3 chunk 처리에서 채워진다.

### JobRepository 인터페이스

```ts
interface JobRepository {
  // 인스턴스 / 실행
  resolveInstance(jobName: string, jobKey: string): Promise<JobInstance>;          // upsert
  findLastExecution(instanceId: number): Promise<JobExecution | null>;             // restart 판정
  createExecution(instanceId: number, params: JobParameters): Promise<JobExecution>;
  finishExecution(execId: number, status: string, exitStatus: string,
                  opts?: { error?: string; meta?: ResultMeta }): Promise<void>;

  // step
  startStep(execId: number, stepName: string, seqNo: number): Promise<StepExecution>;
  finishStep(stepExecId: number, status: string, exitStatus: string,
             opts?: { error?: string; durationMs?: number; counts?: StepCounts }): Promise<void>;
  findStepExecutions(execId: number): Promise<StepExecution[]>;                     // 통과 경로 복원

  // ExecutionContext
  saveContext(ownerType: 'JOB' | 'STEP', ownerId: number, ctx: Record<string, unknown>): Promise<void>;
  loadContext(ownerType: 'JOB' | 'STEP', ownerId: number): Promise<Record<string, unknown> | null>;
}
```

**v0.1 구현 2종**:
- `MySqlJobRepository` — 프로덕션 (mysql2 prepared statement 직접 사용)
- `InMemoryJobRepository` — 테스트/로컬 (DB 인프라 불필요)

두 구현은 **동일한 repository contract 테스트 스위트**를 통과해야 한다 (§12). 후속 버전에서 Postgres 어댑터 추가 가능.

## 10. 기술 스택

| 영역 | 선택 | 비고 |
|---|---|---|
| 언어 | TypeScript (strict) | 타입 추론이 빌더 API의 핵심 |
| 런타임 | Node.js 20+ LTS | |
| 배포 포맷 | ESM + CJS 듀얼 | |
| 브라우저 | **`puppeteer`** (peerDependency) | 타입 의존만, launch는 소비자 |
| DB 드라이버 | **`mysql2`** (peerDependency) | 사용자가 커넥션 풀 주입 |
| 빌드 | `tsup` | esbuild 기반 듀얼 번들 + d.ts |
| 테스트 | `vitest` | **InMemoryJobRepository 중심** (§12) |
| 패키지 매니저 | **`npm`** | 단일 패키지, workspaces 불필요 |
| 린트/포맷 | eslint + prettier | |

### 의존성 철학
- 코어 런타임 의존성 최소화 (엔진/빌더/전이/해시는 순수 TS)
- `puppeteer`/`mysql2`는 **peerDependency** — stepflow가 브라우저도 커넥션도 소유하지 않고 주입받음
- ORM(Prisma/TypeORM) 미사용 — `mysql2` prepared statement 직접 사용
- 로거는 인터페이스만 의존

### 의도적 배제 (v0.1)
- ❌ NestJS 코어 결합 (후속 `@stepflow/nestjs` 어댑터 여지만 남김)
- ❌ Postgres 어댑터 (인터페이스만 분리)
- ❌ ORM / DI 컨테이너 / 마이그레이션 툴
- ❌ retry / chunk / 병렬 (로드맵 §15)

## 11. 패키징

- **단일 패키지 `stepflow`** (MySQL + InMemory JobRepository 내장)
- 디렉터리 개략:
  - `src/core/` — `defineJob` 빌더, Flow 그래프, `runJob` 엔진, Step 계약, job_key 해시
  - `src/repository/` — `JobRepository` 인터페이스 + `MySqlJobRepository` + `InMemoryJobRepository`
  - `src/schema.sql` — DDL
  - `test/contract/` — repository contract 테스트 (두 구현 공용)
  - `examples/` — agent-server Job을 stepflow로 옮긴 레퍼런스 예제

## 12. 테스트 전략 (InMemory 중심)

- **순수 단위 (브라우저 X)**: 빌더 그래프·선형/분기 전이·정적 검증·`job_key` 해시·restart 경로 복원 로직 — vitest
- **엔진 통합 (InMemory)**: `runJob` 전체 흐름·exit status 분기·실패→restart 라운드트립을 `InMemoryJobRepository` 로 검증 (DB 인프라 불필요, 빠르고 결정적)
- **repository contract 테스트**: 동일 스위트를 `InMemoryJobRepository`(항상)와 `MySqlJobRepository`(`MYSQL_URL` 있으면 opt-in)에 돌려 인터페이스 적합성 보장
- **e2e 레퍼런스**: `agent-server`의 `sabangnet_pull`을 stepflow로 이식, 중간 실패 후 재시작 시 성공 step을 건너뛰고 실패 지점부터 재개됨을 검증

## 13. v0.1 범위 (Scope)

**포함**
- 함수형 Step 계약 + `StepContext`(`page` 주입, `params`, `shared`)
- 선형 기본 + 분기 예외 빌더 API + 정적 검증
- `runJob` 엔진 (page 주입 전용, launch 안 함)
- JobParameters 1급 + JobInstance 식별 + 인스턴스 단위 restart
- ExecutionContext(`shared`) 영속·복원
- L3 스키마 + `schema.sql`
- `MySqlJobRepository` + `InMemoryJobRepository` + contract 테스트
- vitest 단위/엔진(InMemory)/e2e 테스트

**제외 (후속 → §15)**
- retry / recovery policy
- listeners / hooks
- chunk-oriented 처리 / skip policy
- 병렬 Step / 파티셔닝
- Postgres 어댑터, NestJS 어댑터, 대시보드 UI

## 14. ⚠️ 위 설계가 강제한 귀결 (검토 포인트 기록)

1. **ExecutionContext 영속은 선택이 아니라 restart 정합성 필수.** step A가 `shared.rows`를 만들고 B가 쓰는데 restart에서 A를 skip하면 B가 데이터를 잃는다 → `shared`를 step 경계마다 영속/복원해야 한다. (L3 스키마를 고른 실질적 값어치)
2. **브라우저 세션 restart 한계** (§8) — "데이터 재개 + 세션 재확립" 모델로 문서화.
3. **retry vs page-injection 긴장** — page를 단일 주입하므로, 후속 retry에서 "fresh page 재시도"는 page 팩토리가 필요. v0.2에서 (a) 같은 page 재시도 기본 + (b) 옵션 `pageFactory` 결정.

## 15. 로드맵 (전체 목표 = Spring Batch 기능 이식)

| 버전 | 내용 |
|---|---|
| **v0.1 (이번)** | 선형+분기 빌더 · page 주입 · L3 스키마 · 파라미터 1급 + 인스턴스 restart · ExecutionContext 영속 · MySql/InMemory repository |
| **v0.2** | retry/recovery (백오프 + 실패 아티팩트: 스크린샷/HTML) · listeners (lifecycle seam 공식화) · 파라미터 검증/incrementer |
| **v0.3** | chunk-oriented (ItemReader/Processor/Writer + skip policy + `execution_context` 체크포인트 = item 700부터 재개) |
| **later** | 병렬/파티셔닝(멀티 브라우저) · Postgres/InMemory 외 어댑터 · `@stepflow/nestjs` · watchdog 대시보드 이식 |

## 16. 성공 기준

- `agent-server`의 기존 Puppeteer Job 1개(예: `sabangnet_pull`)를 stepflow로 재구현하여 동일 동작
- Step 중간 실패 후 재시작 시 성공 Step을 건너뛰고 실패 지점부터 재개됨을 **InMemory 통합테스트**로 검증
- 동일 jobName이라도 파라미터가 다르면 별도 인스턴스로 분리되어 restart가 섞이지 않음을 검증
- `npm install stepflow` 시 무거운 전이 의존성 없이 설치됨 (puppeteer/mysql2는 peer)

## 17. 변경 이력 (v0.1 → v0.2)

| 항목 | v0.1 | v0.2 |
|---|---|---|
| 오써링 API | `.start()` + 명시적 `.on(step,status).to(next)` | **선형 기본 `.step()` + 분기 예외 `.branch()`** |
| Puppeteer | `dependency`, 주입 없으면 stepflow가 launch | **`peerDependency`, page 주입 전용 (launch 안 함)** |
| 메타데이터 | L1 (job_execution + step_execution) | **L3 (instance + params + execution_context + L2 메트릭)** |
| 파라미터 | 없음 | **JobParameters 1급 (ctx.params)** |
| restart 정체성 | jobName 기준 마지막 실패 | **JobInstance(jobName + 식별 params) 기준** |
| ExecutionContext | `shared` 인메모리만 | **영속·복원 (restart 정합성)** |
| Repository 구현 | MySql만 (InMemory는 후속) | **MySql + InMemory (테스트), contract 테스트** |
