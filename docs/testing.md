# 테스트 전략

stepflow의 테스트 운영 기준 문서. 설계 의도(왜 InMemory 중심인가)는
[`design.md`](./design.md) §12를 참조하고, 이 문서는 _어떻게 테스트하는가_ 를
규정한다.

## 철학

**InMemory 중심, 인프라 없이 빠르고 결정적으로.** 테스트는 실제 Chromium도, 실제
DB도 띄우지 않는 것을 기본으로 한다. 브라우저는 `Page` 테스트 더블로, 영속화는
`InMemoryJobRepository`로 대체해 모든 CI 실행에서 항상 돈다.

## 4개 레이어

1. **순수 단위 (브라우저 X)** — 빌더 그래프, 선형/분기 전이, 정적 검증, `job_key`
   해시, restart 경로 복원 로직. 의존성 없이 함수 단위로 검증한다.
2. **엔진 통합 (InMemory)** — `runJob` 전체 흐름, exit status 분기, 실패→restart
   라운드트립을 `InMemoryJobRepository`로 검증한다. Puppeteer `page`는
   `@kmgeon/stepflow/test`의 `createFakePage` 더블로 대체한다.
3. **repository contract** — `@kmgeon/stepflow/test`의
   `describeJobRepositoryContract` 동일 스위트를 모든 구현에 돌려 인터페이스
   적합성을 보장한다. `InMemoryJobRepository`는 항상, `MySqlJobRepository`는
   `MYSQL_URL`이 있을 때만(opt-in) 실행된다. `SqliteJobRepository`는 in-memory
   SQLite로 매번 돈다.
4. **e2e 레퍼런스** — `examples/`의 `orders_sync`로 중간 실패 후 재시작 시 성공
   step을 건너뛰고 실패 지점부터 재개됨을 검증한다.

## 실행 방법

```sh
npm run test           # 전체 (vitest run)
npm run check          # typecheck + lint + test — CI 게이트와 동일
npm run test:coverage  # 커버리지

# MySQL contract 테스트는 opt-in (없으면 자동 skip)
MYSQL_URL='mysql://user:pass@localhost:3306/stepflow' npm run test
```

- CI는 `PUPPETEER_SKIP_DOWNLOAD=true`로 Chromium 다운로드를 막는다 — 더블만 쓰므로
  실제 브라우저가 필요 없다.
- MySQL 테스트는 `MYSQL_URL` 미설정 시 skip되므로, 로컬에서 영속화 어댑터를
  건드렸다면 직접 DB를 띄워 한 번 돌려본다.

## 위치 규약

테스트는 `test/<module>/` 아래에 두어 `src/` 구조를 그대로 반영한다.

```
src/engine/run-job.ts          → test/run-job.test.ts            (core는 test/ 루트)
src/puppeteer/page-pool.ts     → test/puppeteer/page-pool.test.ts
src/infrastructure/sqlite.ts   → test/infrastructure/sqlite.test.ts
```

- 내부 구현을 직접 테스트할 때는 상대경로(`../../src/<module>/<file>`)로 import
  한다.
- 패키지의 공개 표면(subpath exports)을 검증할 때는 패키지 이름으로 import한다
  (`@kmgeon/stepflow`, `@kmgeon/stepflow/puppeteer` …). 이 이름들은
  `vitest.config.ts`의 alias가 `src/`로 해석한다 — 빌드된 `dist/`가 아니라 항상
  소스를 대상으로 돈다. `test/exports.test.ts`가 그 예다.

## 새 테스트를 추가할 때

- 새 모듈을 만들면 `test/<module>/`에 같은 구조로 테스트를 둔다.
- repository 구현을 추가하면 반드시 `describeJobRepositoryContract`를 통과시킨다.
- 브라우저가 필요한 시나리오는 `createFakePage`로 더블을 쓰고, 실제 Chromium에
  의존하는 테스트는 만들지 않는다.

## CI 연계

`.github/workflows/ci.yml`이 PR과 `main` push에서 `npm run check` → `npm run build`
를 돌린다. 즉 로컬에서 `npm run check`가 녹색이면 CI 테스트 게이트를 그대로 재현한
것이다.
