# AGENTS.md

이 저장소에서 작업하는 모든 에이전트(Claude, Codex 등)의 단일 진실 소스다.
`CLAUDE.md`는 이 파일을 import만 하므로, 두 하네스가 동일한 지침을 읽는다.

- **어떻게 일하나** → 이 문서 (§2–11)
- **무엇을·왜 만드나** (목표, restart 모델, 메타데이터 스키마, 설계 결정) →
  [`stepflow-docs/design.md`](./stepflow-docs/design.md). 엔진 동작, repository 계약,
  메타데이터 모델을 바꾸기 전에 반드시 먼저 읽는다.

이 문서와 `stepflow-docs/design.md`가 _시스템이 무엇을 해야 하는가_ 에서 충돌하면
`stepflow-docs/design.md`가 우선한다 — 설계 의도를 정의하는 문서다. 이 문서는 _어떻게
일하는가_ 를 규정한다.

## 1. 이 프로젝트는 무엇인가

**stepflow**는 선언적 Puppeteer RPA 배치 런타임이다. Job을 명명된 Step/Flow로
정의하고, 주입된 Puppeteer `page` 위에서 실행하며, 실행 이력(Spring Batch 스타일의
JobInstance / JobExecution / ExecutionContext)을 영속화해서 실패한 실행이 실패한
step부터 재시작된다. TypeScript로 작성하며 **npm workspaces 모노레포**로 관리하고
모듈별 패키지로 npm에 배포한다 — 코어는 `@kmgeon/stepflow-core`, 합본 엄브렐러는
`@kmgeon/stepflow`(§8).

엔진은 브라우저를 직접 띄우거나 DB 커넥션을 소유하지 않는다 — 호출자가 `page`와
repository를 주입한다. 이 의존성 역전을 깨지 말 것.

## 2. 코딩 전에 생각하라

추측하지 말고, 혼란을 숨기지 말고, 트레이드오프를 드러내라. 구현 전에:

- 가정은 명시적으로 말하고, 불확실하면 물어본다.
- 해석이 여러 개면 전부 제시한다 — 말없이 하나를 고르지 않는다.
- 더 단순한 방법이 있으면 말하고, 필요하면 반론한다.
- 불분명하면 멈추고, 무엇이 헷갈리는지 짚고, 물어본다.

## 3. 단순함 우선

문제를 푸는 최소한의 코드만 작성한다. 추측성 코드는 금지.

- 요청받지 않은 기능 추가 금지.
- 일회성 코드에 대한 추상화 금지.
- 요청하지 않은 "유연성"·설정 가능성 금지.
- 일어날 수 없는 상황에 대한 에러 처리 금지.
- 200줄이 50줄이 될 수 있으면 다시 쓴다.

시니어 엔지니어가 과하다고 할지 자문하고, 그렇다면 단순화한다.

## 4. 외과적(surgical) 변경

꼭 필요한 곳만 건드리고, 네가 만든 것만 정리한다.

- 인접 코드·주석·포맷을 "개선"하지 않는다.
- 망가지지 않은 것을 리팩터링하지 않는다.
- 다르게 하고 싶더라도 기존 스타일을 따른다.
- 무관한 죽은 코드는 지우지 말고 언급만 한다.
- 네 변경으로 고아가 된 import·변수·함수만 제거한다.

기준: 바뀐 모든 줄이 사용자의 요청으로 직접 추적되어야 한다.

## 5. 목표 주도 실행

성공 기준을 정하고, 검증될 때까지 반복한다.

작업을 검증 가능한 목표로 변환:

- "검증 추가" → "잘못된 입력에 대한 테스트를 쓰고, 통과시킨다"
- "버그 수정" → "버그를 재현하는 테스트를 쓰고, 통과시킨다"
- "X 리팩터링" → "전후로 테스트가 통과함을 보장한다"

여러 단계 작업이면 간단한 계획을 먼저 밝힌다:

```
1. [단계] → 검증: [확인 방법]
2. [단계] → 검증: [확인 방법]
```

## 6. 주석: "왜"를 간결하게

코드가 설계 문서나 자명하지 않은 제약을 따를 때, 그렇게 동작하는 이유를 한두 줄로
남긴다(안전 제약, 호환성 shim, 설계 규칙). 코드가 무엇을 하는지 다시 말하거나
메커니즘을 서술하지 않는다.

## 7. 파일·모듈 이름

`helpers`, `utils`, `common`, `misc` 같은 모호한 이름은 절대 쓰지 않는다 — 정보가
없고 잡동사니 창고가 된다. 파일은 담고 있는 내용으로, 일반적 역할보다 도메인 개념을
앞세워 이름 짓는다(`run-job.ts`, `job-repository.ts`, `page-pool.ts`). `helpers`에
손이 간다면 그 파일이 책임을 둘 이상 지고 있거나, 더 나은 이름이 코드 안에 숨어
있다는 신호다.

## 8. 저장소 구조

npm workspaces 모노레포. 모듈마다 패키지 하나이며, 각 패키지는 자체 `src/`·`test/`·
`package.json`·`tsconfig.json`·`tsup.config.ts`·`vitest.config.ts`를 가진다.

| 디렉터리                   | 패키지                            | 배포    | 내용                                         |
| -------------------------- | --------------------------------- | ------- | -------------------------------------------- |
| `stepflow-core/`           | `@kmgeon/stepflow-core`           | ✅      | 엔진·빌더·메타데이터·in-memory repo          |
| `stepflow-puppeteer/`      | `@kmgeon/stepflow-puppeteer`      | ✅      | 페이지 풀·병렬 러너                          |
| `stepflow-infrastructure/` | `@kmgeon/stepflow-infrastructure` | ✅      | MySQL/SQLite repo (+ `schema*.sql`)          |
| `stepflow-integration/`    | `@kmgeon/stepflow-integration`    | ✅      | 트리거 seam·manual/interval                  |
| `stepflow-test/`           | `@kmgeon/stepflow-test`           | ✅      | repository 계약 스위트·Page 테스트 더블      |
| `stepflow-bundle/`         | `@kmgeon/stepflow`                | ✅      | **엄브렐러** — core+puppeteer+infra 재export |
| `stepflow-samples/`        | `@kmgeon/stepflow-samples`        | private | 레퍼런스 job 예제                            |
| `stepflow-docs/`           | `@kmgeon/stepflow-docs`           | private | 설계 문서(`design.md`)                       |

규칙:

- **패키지 간 참조는 패키지 이름으로** (`@kmgeon/stepflow-core` 등). workspaces가
  로컬로 링크하고, 개발/타입체크/테스트는 `tsconfig.base.json`의 `paths`와 각 패키지
  `vitest.config.ts`의 alias가 `../stepflow-*/src`로 해석한다. 내부 의존성 버전은
  `^0.3.0`로 맞춘다.
- **무거운 백엔드는 (optional) peerDependency.** `puppeteer`(core·puppeteer·test),
  `mysql2`·`better-sqlite3`(infrastructure)는 코드에서 `import type`로만 참조한다 —
  소비자가 인스턴스를 주입하므로 런타임에 로드되지 않는다.
- 엄브렐러 `@kmgeon/stepflow`(stepflow-bundle)는 새 export를 추가하지 말고 trio
  재export만 유지한다.

## 9. 린트 & 포맷

규칙을 끄지 않는다. 커밋 전에 린트와 포맷이 통과해야 한다.

- ESLint 설정: `eslint.config.js` (typescript-eslint, type-checked 규칙).
  `eslint-disable`을 뿌리지 말고 원인을 고친다.
- 포매터는 Prettier. `npm run format:check`가 깨끗해야 한다. Husky +
  lint-staged pre-commit 훅이 `eslint --fix`와 `prettier --write`를 실행한다.

## 10. 테스트 & CI

Vitest 사용. **InMemory 중심** — 실제 Chromium도 DB도 띄우지 않는 게 기본이다
(Puppeteer `page`는 `@kmgeon/stepflow-test`의 `createFakePage` 더블로 대체).

- PR 전에 `npm run check`(= `typecheck` + `lint` + `test`, 전 워크스페이스)를 녹색으로
  통과시킨다. 이게 곧 CI 게이트다(`.github/workflows/ci.yml`, 이어서 `npm run build`).
- 두 repository 구현(`InMemory`/`MySql`/`Sqlite`)은 `@kmgeon/stepflow-test`의
  `describeJobRepositoryContract` 동일 스위트를 통과해야 한다.
- MySQL contract 테스트는 `MYSQL_URL`이 있을 때만 돈다(opt-in). 영속화 어댑터를
  건드렸으면 로컬에서 한 번 돌려본다.

## 11. 빌드 & 릴리스

각 패키지는 `tsup`로 ESM/CJS 듀얼 + `.d.ts`를 낸다. 루트 `npm run build`가 전
워크스페이스를 빌드한다. 배포는 Changesets.

- `dist/`를 손으로 수정하지 않는다.
- 사용자 영향이 있는 변경에는 `npm run changeset`으로 changeset을 추가한다. 내부 의존
  패키지는 함께 버전이 오른다(`.changeset/config.json`의 `updateInternalDependencies`).
- 전부 public(`publishConfig.access: "public"`). `@kmgeon/stepflow-docs`·
  `@kmgeon/stepflow-samples`는 배포 제외(changeset `ignore`). 엄브렐러
  `@kmgeon/stepflow`는 trio와 버전을 맞춰 함께 게시한다.
