# stepflow

<p align="center">
  <img src="assets/stepflow.png" alt="stepflow" width="760" />
</p>

[![npm](https://img.shields.io/npm/v/@kmgeon/stepflow?label=%40kmgeon%2Fstepflow)](https://www.npmjs.com/package/@kmgeon/stepflow)
[![license](https://img.shields.io/npm/l/@kmgeon/stepflow)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-339933)](package.json)
[![typescript](https://img.shields.io/badge/TypeScript-strict-3178c6)](tsconfig.base.json)

Declarative Puppeteer browser-automation workflows. Define a job as named
Step/Flow, run it against an injected Puppeteer `page`, and persist execution
history so a failed run resumes from the step that failed instead of repeating
work that already completed.

```ts
const result = await runJob(ordersSync, {
  page,
  repository,
  params: { since: '2026-06-01' },
});

// { instanceId, executionId, status, exitStatus, restarted }
```

## Why stepflow?

- **Restart from failure**: a failed execution resumes from the failed step with
  its shared execution context restored.
- **Declarative Step/Flow**: compose named steps with linear progression and
  exit-status branching; the engine records every JobInstance / JobExecution /
  StepExecution and ExecutionContext.
- **You own runtime resources**: stepflow never launches a browser or owns a DB
  connection. Inject the Puppeteer `page` and the repository you choose.
- **One install, everything in it**: a single `@kmgeon/stepflow` ships the engine,
  the parallel Puppeteer runtime, durable MySQL/SQLite repositories, triggers, and
  test utilities. Import each from its own subpath, so unused modules stay out of
  your bundle (ESM tree-shaking, `sideEffects: false`).
- **Batteries when you want them**: retry policies, chunk-oriented steps,
  lifecycle listeners, durable MySQL/SQLite repositories, schedule triggers, and
  a bounded parallel Puppeteer runtime.
- **TypeScript-native**: strict types, dual ESM/CJS output, small public APIs.

## Install

```sh
npm install @kmgeon/stepflow
```

That's it — the engine, the parallel runtime, the durable repositories, triggers,
and test utilities all come from this one package. `puppeteer`, `mysql2`, and
`better-sqlite3` are regular dependencies, so a fresh install is ready to drive a
browser and persist to SQLite or MySQL with no extra steps.

Import each capability from its subpath:

```ts
import { defineJob, runJob, InMemoryJobRepository } from '@kmgeon/stepflow';
import { runJobsParallel, createPagePool } from '@kmgeon/stepflow/puppeteer';
import { MySqlJobRepository, SqliteJobRepository } from '@kmgeon/stepflow/infrastructure';
import { intervalTrigger, createManualTrigger } from '@kmgeon/stepflow/integration';
import { describeJobRepositoryContract, createFakePage } from '@kmgeon/stepflow/test';
```

| Subpath                           | What it gives you                                             |
| --------------------------------- | ------------------------------------------------------------- |
| `@kmgeon/stepflow`                | Job builder, execution engine, metadata model, in-memory repo |
| `@kmgeon/stepflow/puppeteer`      | Bounded page pool + parallel job runner with per-job timeouts |
| `@kmgeon/stepflow/infrastructure` | Durable MySQL & SQLite `JobRepository` adapters               |
| `@kmgeon/stepflow/integration`    | Trigger seam plus manual and interval triggers                |
| `@kmgeon/stepflow/test`           | Repository contract suite, recording listener, `Page` doubles |

## Quick Start

```ts
import puppeteer from 'puppeteer';
import { defineJob, InMemoryJobRepository, runJob } from '@kmgeon/stepflow';

const ordersSync = defineJob('orders_sync')
  .step('login', async (ctx) => {
    await ctx.page.goto('https://example.com/login');
    await ctx.page.type('#username', String(ctx.params.username));
    await ctx.page.type('#password', String(ctx.params.password));
    await ctx.page.click('button[type="submit"]');
    await ctx.page.waitForNavigation();
  })
  .step('parse', async (ctx) => {
    const count = await ctx.page.$$eval('#orders tr', (rows) => rows.length);
    ctx.shared.count = count;
    return count > 0 ? 'COMPLETED' : 'EMPTY';
  })
  .step('confirm', async (ctx) => {
    await ctx.page.click('#confirm');
    await ctx.page.waitForSelector('#confirm-done');
  })
  .step('cleanup', async (ctx) => {
    await ctx.page.click('#logout');
  })
  .branch('parse', { EMPTY: 'cleanup' })
  .build();

const browser = await puppeteer.launch();
const page = await browser.newPage();

const result = await runJob(ordersSync, {
  page,
  repository: new InMemoryJobRepository(),
  params: { username: process.env.USERNAME ?? '', password: process.env.PASSWORD ?? '' },
});

await browser.close();
console.log(result.status, result.exitStatus);
```

Steps run in registration order when they return `COMPLETED`. `.branch()`
overrides the next step for specific exit statuses. A step fails when it throws
or returns `FAILED`; `runJob` reports job-level failure via `result.status`
instead of throwing.

## Retry

Attach a per-step retry policy. Only thrown errors are retried — an explicit
`FAILED` return is an intended outcome and is never retried.

```ts
const job = defineJob('orders_sync')
  .step('search', searchRun)
  .retry('search', { maxAttempts: 3, backoff: { delayMs: 1000, multiplier: 2 } })
  .build();
```

## Chunk processing

Process large inputs in committed chunks. The committed offset is checkpointed,
so a restart resumes after the last committed chunk (writers should be
idempotent — semantics are at-least-once).

```ts
const job = defineJob('orders_sync')
  .chunkStep('import', {
    chunkSize: 50,
    reader: (ctx) => fetchOrders(ctx), // sync or async iterable, deterministic
    processor: (order) => normalize(order), // optional
    writer: (batch) => saveAll(batch),
  })
  .build();
```

## Listeners

Observe the run lifecycle (notifications, metrics). Listeners never control flow,
and a throwing listener is isolated — it never aborts the job.

```ts
await runJob(job, {
  page,
  repository,
  listeners: [
    {
      afterStep: (_ctx, step, outcome) => log(`${step.stepName}: ${outcome.status}`),
      onRetry: (_ctx, step, info) => log(`retry ${step.stepName} #${info.attempt}`),
    },
  ],
});
```

## Durable restart

Use `@kmgeon/stepflow/infrastructure` when executions must survive process restarts.
MySQL and SQLite repositories ship with identical behavior.

```ts
import { MySqlJobRepository, SqliteJobRepository } from '@kmgeon/stepflow/infrastructure';
import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';

const repository = new MySqlJobRepository(mysql.createPool(process.env.MYSQL_URL));
// …or
const repository = new SqliteJobRepository(new Database('stepflow.db'));
```

Apply the matching schema once before use:
`@kmgeon/stepflow/schema.sql` (MySQL) or
`@kmgeon/stepflow/schema.sqlite.sql` (SQLite). Re-running the same job
with the same identifying `params` resumes the previous failed instance from the
failed step and restores the shared `ExecutionContext`.

## Parallel execution

`@kmgeon/stepflow/puppeteer` runs one job across many parameter sets concurrently, each
on an isolated `BrowserContext`, bounded by a page pool. A per-job timeout aborts
the step's `signal` and force-closes its context, so a hung run can never block
the batch; failures are isolated per job.

```ts
import { runJobsParallel } from '@kmgeon/stepflow/puppeteer';

const results = await runJobsParallel(ordersSync, paramsList, {
  repository,
  concurrency: 8,
  jobTimeoutMs: 60_000,
});
```

For cooperative cancellation, forward `ctx.signal` to Puppeteer calls inside your
steps (e.g. `ctx.page.goto(url, { signal: ctx.signal })`).

## Triggers

`@kmgeon/stepflow/integration` provides the trigger seam for deciding _when_ a job runs.
A trigger does not know _how_ to run a job; it receives a `run` function.

```ts
import { intervalTrigger } from '@kmgeon/stepflow/integration';

const handle = await intervalTrigger(60_000).start(() =>
  runJob(ordersSync, { page, repository, params: { since: '2026-06-01' } }),
);

// later
await handle.stop();
```

Use `createManualTrigger()` for tests, CLI commands, or hand-operated runs.

## Entry points

Everything ships in one package, `@kmgeon/stepflow`, exposed through subpath
exports so you import only what you use:

| Entry point                       | Purpose                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `@kmgeon/stepflow`                | Job builder, execution engine, metadata model, and in-memory repository.     |
| `@kmgeon/stepflow/infrastructure` | Durable `JobRepository` adapters: MySQL and SQLite.                          |
| `@kmgeon/stepflow/integration`    | Trigger seam plus manual and interval trigger implementations.               |
| `@kmgeon/stepflow/puppeteer`      | Bounded page pool and parallel job runner with per-job timeout cancellation. |
| `@kmgeon/stepflow/test`           | Repository contract suite, recording listener, and Puppeteer `Page` doubles. |
| `@kmgeon/stepflow/schema.sql`     | MySQL DDL asset. `…/schema.sqlite.sql` for SQLite.                           |

## Development

Single-package repo. Source lives under `src/<module>/`, tests under
`test/<module>/`, runnable examples under `examples/`.

```sh
npm install
npm run check          # typecheck + lint + test
npm run build          # dual ESM/CJS + declaration output, one entry per subpath
npm run test:coverage  # coverage thresholds where applicable
npm run format:check
```

SQLite repository tests run in-memory on every invocation. MySQL repository tests
are opt-in:

```sh
MYSQL_URL='mysql://user:pass@localhost:3306/stepflow' npm run test
```

Release metadata is managed with Changesets:

```sh
npm run changeset
npm run version-packages
npm run release
```

## Design

Read [the design doc](docs/design.md) for the restart model and metadata
schema.

## License

MIT
