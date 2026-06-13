# stepflow 모듈화 설계 (v1)

> 작성일: 2026-06-13
> 상태: 설계 승인 완료, 자율 실행 진입
> 목표: 단일 패키지 stepflow를 Spring Batch 모듈 레이아웃(core/infrastructure/docs/samples/test)으로 모노레포화하고, agent-server 흔적을 완전히 제거하여 독립 라이브러리로 완성.

## 1. 확정된 결정 (브레인스토밍)

| 항목            | 결정                                                                                    |
| --------------- | --------------------------------------------------------------------------------------- |
| 모노레포 툴링   | **npm workspaces**, `@stepflow/*` 분리 publish                                          |
| 퍼블리시 대상   | `@stepflow/core`, `@stepflow/infrastructure`, `@stepflow/test` (samples/docs는 private) |
| core↔infra 경계 | **InMemory=core**(의존성 0 기본 repo), **MySql=infrastructure**(mysql2 peer)            |
| codex 리뷰      | 체크포인트마다 `codex exec` 자동 호출(비판적 health-check) → confirmed만 반영           |
| 실행 모델       | **리더(메인 세션) + Workflow 오케스트레이션** + codex 외부 비판자                       |

## 2. 모노레포 레이아웃

```
stepflow/                       # 루트(private, workspace 매니저)
├── package.json                # "private": true, "workspaces": ["packages/*"]
├── tsconfig.base.json          # 공유 strict 설정(현 tsconfig 승계)
├── eslint.config.js            # 공유 type-checked ESLint
├── .prettierrc.json
├── .husky/                     # pre-commit(lint-staged 전역) · pre-push(전 패키지 typecheck+test)
└── packages/
    ├── core/                   → @stepflow/core            (PUBLISH)
    ├── infrastructure/         → @stepflow/infrastructure  (PUBLISH)
    ├── test/                   → @stepflow/test            (PUBLISH, 테스트 유틸)
    ├── samples/                → private 제네릭 예제
    └── docs/                   → private 설계·아키텍처 문서 + TypeDoc
```

## 3. 모듈 경계 & 의존 그래프

```
@stepflow/core           런타임 의존 0 (puppeteer=peer, 타입만)
  ├ types.ts             ExitStatus/BatchStatus/StepContext/Step/Logger/JobParameters/COMPLETED/FAILED
  ├ errors.ts            JobDefinitionError
  ├ job-key.ts           computeJobKey
  ├ define-job.ts        defineJob/Job/JobBuilder/StepLocation
  ├ run-job.ts           runJob/RunJobOptions/RunJobResult
  ├ job-repository.ts    JobRepository 인터페이스 + Finish* 입력
  ├ metadata.ts          JobInstance/JobExecution/StepExecution/StepCounts/ResultMeta/ContextOwnerType
  └ in-memory.ts         InMemoryJobRepository (DB프리 기본 repo)
     ▲                    ▲                      ▲
@stepflow/infrastructure  @stepflow/test         samples (private)
  ├ mysql.ts (MySql)        ├ contract 하네스       └ 제네릭 잡(orders_sync)
  └ schema.sql              └ FakePage 등 테스트 더블
  (core 의존, mysql2=peer)  (core 의존)
docs (private): core/infra에서 TypeDoc로 API 문서 생성 + 설계/아키텍처 마크다운
```

- **core**: 순수 TS, 의존성 0 → `@stepflow/core` + InMemory만으로 완전 동작·테스트
- **infrastructure**: `@stepflow/core` 의존, `mysql2` peer. MySqlJobRepository + `schema.sql`
- **test**: `@stepflow/core` 의존. `describeJobRepositoryContract`(공용 계약 스위트), `FakePage`(Puppeteer Page 테스트 더블), 테스트 런처 헬퍼. infra/samples가 소비
- **samples**: private. 제네릭 예제(§5)
- **docs**: private. 설계 문서(현 v0.2 genericized) + 아키텍처 + TypeDoc 설정

## 4. 코드 마이그레이션 (git mv로 이력 보존)

| 현재                                                    | 이동 후                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| `src/core/{types,errors,job-key,define-job,run-job}.ts` | `packages/core/src/{types,errors,job-key,define-job,run-job}.ts`  |
| `src/repository/job-repository.ts`                      | `packages/core/src/job-repository.ts`                             |
| `src/repository/types.ts`                               | `packages/core/src/metadata.ts` (이름 충돌 회피)                  |
| `src/repository/in-memory.ts`                           | `packages/core/src/in-memory.ts`                                  |
| `src/repository/mysql.ts` · `src/schema.sql`            | `packages/infrastructure/src/{mysql.ts,schema.sql}`               |
| `test/contract/job-repository.contract.ts`              | `packages/test/src/job-repository-contract.ts` (export)           |
| `test/core/*`, `test/repository/in-memory.test.ts`      | `packages/core/test/*`                                            |
| `test/repository/mysql.test.ts`                         | `packages/infrastructure/test/*`                                  |
| `examples/sabangnet-pull.*`                             | 삭제 → `packages/samples/src/orders-sync.ts` (제네릭)             |
| `README.md`(설계 v0.2)                                  | `packages/docs/`로 이동·genericize. 루트 README는 공개용으로 신규 |

인-레포 해상도: `tsconfig.base.json` path alias + vitest alias로 `@stepflow/core` → `packages/core/src`(빌드 없이 typecheck/test). publish 시엔 각 `package.json` `dependencies` + `dist`.

## 5. agent-server 완전 제거 (하드 요구)

- `examples/sabangnet-pull.*` 삭제 → 제네릭 예제 `orders_sync`: 가공의 `https://example.com` 쇼핑몰 주문확정 잡 (login→search→parse→confirm→cleanup + `EMPTY` 분기). 실제 회사명/agent-server/BrowserService/watchdog/sabangnet/naver/shopify 표현 0
- 루트 README: 공개용(무엇/왜/설치/quickstart/패키지 표/링크)
- 설계 문서(docs): agent-server 배경·"대응 표"·watchdog·BrowserService 제거, 동기를 제네릭하게 재서술
- `job-key.test`의 `'sabangnet_pull'` → 중립값(`'orders_sync'`)
- **게이트**: `git grep -i -E 'agent-server|sabangnet|tbnws|watchdog|naver|shopify|BrowserService|hyundai|unistore|cafe24'` = 0건

## 6. 실행 단계 (리더 + Workflow + codex)

1. **스캐폴드**(리더 직접): 루트 package.json/tsconfig.base/eslint/husky + 5패키지 골격(package.json/tsconfig/tsup/vitest)
2. **core 이관·green**: 파일 이동 + import 정리, `@stepflow/test` 계약으로 InMemory 테스트, core 단독 build/test/lint green
3. **test 유틸**: contract 하네스 + FakePage → `@stepflow/test`
4. **infrastructure 이관·green**: MySql + schema, 실 MySQL 계약테스트(opt-in)
5. **samples 제네릭화**: `orders_sync` 예제 + 그래프 스모크
6. **docs**: 설계 문서 이동·genericize, 루트 README 신규, TypeDoc 설정
7. **agent-server grep 게이트 = 0**
8. **QA Workflow**: 패키지별 적대적 다차원 리뷰 + 회귀/계약 테스트
9. **codex 비판 리뷰**: `codex exec`로 아키텍처·경계·패키징 health-check → confirmed 반영
10. **최종 게이트**: 전 패키지 typecheck·lint·test·dual빌드 green, husky 동작, grep 0, codex critical 0

## 7. 성공 기준

- `@stepflow/core` 단독으로 InMemory 기반 잡 실행(build/test green)
- `@stepflow/infrastructure`가 core 계약 충족(실 MySQL 계약테스트 통과)
- 전 패키지 typecheck·lint·test·dual빌드 green, husky pre-commit/pre-push 동작
- **agent-server 흔적 grep 0건**
- codex 비판 리뷰에서 critical 0, 주요 결함 반영 완료

## 8. 비범위 (이번 단계)

- retry/listeners/chunk 등 v0.2+ 기능 로드맵 (별도 단계)
- 실제 npm publish 실행 (구조·메타데이터만 준비; 배포는 사용자 트리거)
- CI 파이프라인 구성 (후속)
