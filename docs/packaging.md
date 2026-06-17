# 패키징 전략

stepflow의 패키징·빌드·배포 운영 기준 문서.

## 결정: 단일 패키지

stepflow는 **단일 npm 패키지 `@kmgeon/stepflow`** 로 배포한다. 모든 기능(엔진,
병렬 Puppeteer 런타임, 영속 repository, 트리거, 테스트 유틸)이 한 패키지에 들어
있고, `npm i @kmgeon/stepflow` 한 번으로 전부 설치된다.

**왜 모노레포(다중 패키지)가 아닌가.** 다중 패키지로 쪼개는 정당한 이유는 "안 쓰는
사용자에게 무거운 의존성을 안 깔리게" 하는 것인데, stepflow는 모듈 경계를 subpath
exports + 트리셰이킹(`sideEffects: false`)으로 이미 달성한다. 반대로 다중 패키지는
릴리스마다 버전 lockstep·내부 의존성 갱신·배포 순서 비용을 매번 부과한다. 통합 전
존재하던 `-all` 엄브렐러 패키지(쪼갠 걸 다시 합치는 패키지)가 그 분리가 무용했다는
신호였다.

## subpath exports

| import 경로                          | 소스                  | 내용                                |
| ------------------------------------ | --------------------- | ----------------------------------- |
| `@kmgeon/stepflow`                   | `src/index.ts`        | 엔진·빌더·메타데이터·in-memory repo |
| `@kmgeon/stepflow/puppeteer`         | `src/puppeteer/`      | 페이지 풀, 병렬 러너                |
| `@kmgeon/stepflow/infrastructure`    | `src/infrastructure/` | MySQL / SQLite repository           |
| `@kmgeon/stepflow/integration`       | `src/integration/`    | 트리거 seam, manual/interval 트리거 |
| `@kmgeon/stepflow/test`              | `src/test/`           | contract 스위트, Page 테스트 더블   |
| `@kmgeon/stepflow/schema.sql`        | `src/infrastructure/` | MySQL DDL (정적 에셋)               |
| `@kmgeon/stepflow/schema.sqlite.sql` | `src/infrastructure/` | SQLite DDL (정적 에셋)              |

## 핵심 메커니즘: self-reference + external

subpath 모듈은 core를 **패키지 자기 이름**으로 import한다 — 깊은 상대경로가 아니라
`import { runJob } from '@kmgeon/stepflow'`.

- **빌드 시**: `tsup.config.ts`가 `@kmgeon/stepflow*`를 `external`로 처리한다.
  그래서 `dist/puppeteer/index.js`는 core를 번들에 포함하지 않고 런타임에
  `@kmgeon/stepflow`를 import/require한다 → **core 코드가 정확히 한 번만** 실린다.
- **런타임 시**: Node의 self-reference가 `package.json`의 `exports`를 통해 자기
  패키지를 해석한다. ESM·CJS 양쪽 모두 동작한다.
- **개발/테스트/타입체크 시**: 같은 이름을 `tsconfig.base.json`의 `paths`와
  `vitest.config.ts`의 alias가 `src/`로 해석한다 → 빌드 산출물이 아니라 소스를
  대상으로 작업한다.

## 무거운 의존성 배치 규칙

`puppeteer`, `mysql2`, `better-sqlite3`는 패키지의 **실제 dependency**다(한 번
설치로 전부 동작하게 하기 위함). 단, **import 위치를 강제한다**:

- 이 라이브러리들은 `src/puppeteer/` 또는 `src/infrastructure/` 안에서만 import
  한다.
- core(`src/` 루트, `builder/engine/metadata/repository`)에서는 절대 import하지
  않는다. 그래야 `@kmgeon/stepflow`만 가져오는 사용자에게 브라우저·드라이버 코드가
  딸려오지 않는다.

## 모듈을 추가할 때 (체크리스트)

새 subpath 모듈을 추가하면 다음을 **함께** 갱신한다. 하나라도 빠지면 빌드/타입/배포
중 하나가 깨진다.

1. `package.json` → `exports`에 새 subpath (import/require × types/default)
2. `package.json` → 정적 에셋이면 `files`에도 추가
3. `tsup.config.ts` → `entry` 맵에 `'<module>/index': 'src/<module>/index.ts'`
4. `tsconfig.base.json` → `paths`에 `@kmgeon/stepflow/<module>`
5. `vitest.config.ts` → `resolve.alias`에 동일 항목 (bare 이름보다 **앞**에)

## 빌드

```sh
npm run build   # tsup: ESM + CJS + .d.ts, subpath entry마다 출력 하나
```

- 산출물은 `dist/<module>/index.{js,cjs,d.ts,d.cts}` 구조다.
- `dist/`는 절대 손으로 수정하지 않는다.

## 배포

- 버저닝·배포는 **Changesets**로 한다. 사용자 영향이 있는 변경에는
  `npm run changeset`으로 changeset을 추가한다.
- `.github/workflows/release.yml`이 `main`에서 "Version Packages" PR을 열고,
  머지되면 `npm run release`로 provenance와 함께 배포한다. (`NPM_TOKEN` 시크릿
  필요.)
- 패키지는 public이다 — `publishConfig.access: "public"`이라 수동 `--access public`
  플래그가 필요 없다.
- 배포 내용물은 `files` 화이트리스트로 제한된다: `dist/`, 두 개의 `schema*.sql`,
  `LICENSE`, `README.md`. `src`(스키마 제외)·`test`·`examples`·`docs`는 배포되지
  않는다.

### 수동 배포 (필요 시)

```sh
npm login
npm run build
npm publish
```
