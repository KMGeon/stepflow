# stepflow

<p align="center">
  <img src="assets/stepflow.png" alt="stepflow" width="760" />
</p>

[![npm](https://img.shields.io/npm/v/@stepflow/core?label=%40stepflow%2Fcore)](https://www.npmjs.com/package/@stepflow/core)
[![license](https://img.shields.io/npm/l/@stepflow/core)](LICENSE)
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
- **Install only what you use**: every heavy backend (`puppeteer`, `mysql2`,
  `better-sqlite3`) is an _optional_ peer — installing `@stepflow/core` has zero
  dependencies and pulls in nothing else.
- **Batteries when you want them**: retry policies, chunk-oriented steps,
  lifecycle listeners, durable MySQL/SQLite repositories, schedule triggers, and
  a bounded parallel Puppeteer runtime — each in its own package.
- **TypeScript-native**: strict types, dual ESM/CJS output, small public APIs.

## Install

The minimum is the core engine plus a browser — this is all you need to define
and run jobs:

```sh
npm install @stepflow/core puppeteer
```

**Common setup, one package.** `stepflow` is an umbrella that bundles and
re-exports `@stepflow/core` + `@stepflow/puppeteer` + `@stepflow/infrastructure`,
so the engine, the parallel runtime, and the durable repositories come from a
single install and import:

```sh
npm install stepflow puppeteer better-sqlite3   # add mysql2 instead of/with sqlite as needed
```

```ts
import { defineJob, runJob, runJobsParallel, SqliteJobRepository } from 'stepflow';
```

Triggers (`@stepflow/integration`) and test utilities (`@stepflow/test`) stay
separate — add them when needed.

**Everything else is optional.** Or compose the individual packages directly —
pick only the rows for features you actually use (they're independent; any subset
is fine):
only the rows for features you actually use (they're independent; any subset is
fine):

| You want…                                 | Install                                       |
| ----------------------------------------- | --------------------------------------------- |
| Durable restart across processes (MySQL)  | `@stepflow/infrastructure` + `mysql2`         |
| …or the same with SQLite instead          | `@stepflow/infrastructure` + `better-sqlite3` |
| Manual / interval / scheduled triggers    | `@stepflow/integration`                       |
| Bounded parallel execution over many runs | `@stepflow/puppeteer` + `puppeteer`           |

`puppeteer`, `mysql2`, and `better-sqlite3` are **optional peer dependencies** —
they are never installed automatically, so a package never drags in a backend you
don't use. (The two infrastructure rows are alternatives: choose one DB driver.)

## Quick Start

```ts
import puppeteer from 'puppeteer';
import { defineJob, InMemoryJobRepository, runJob } from '@stepflow/core';

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

Use `@stepflow/infrastructure` when executions must survive process restarts.
MySQL and SQLite repositories ship with identical behavior.

```ts
import { MySqlJobRepository, SqliteJobRepository } from '@stepflow/infrastructure';
import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';

const repository = new MySqlJobRepository(mysql.createPool(process.env.MYSQL_URL));
// …or
const repository = new SqliteJobRepository(new Database('stepflow.db'));
```

Apply the matching schema once before use:
`@stepflow/infrastructure/schema.sql` (MySQL) or
`@stepflow/infrastructure/schema.sqlite.sql` (SQLite). Re-running the same job
with the same identifying `params` resumes the previous failed instance from the
failed step and restores the shared `ExecutionContext`.

## Parallel execution

`@stepflow/puppeteer` runs one job across many parameter sets concurrently, each
on an isolated `BrowserContext`, bounded by a page pool. A per-job timeout aborts
the step's `signal` and force-closes its context, so a hung run can never block
the batch; failures are isolated per job.

```ts
import { runJobsParallel } from '@stepflow/puppeteer';

const results = await runJobsParallel(ordersSync, paramsList, {
  repository,
  concurrency: 8,
  jobTimeoutMs: 60_000,
});
```

For cooperative cancellation, forward `ctx.signal` to Puppeteer calls inside your
steps (e.g. `ctx.page.goto(url, { signal: ctx.signal })`).

## Triggers

`@stepflow/integration` provides the trigger seam for deciding _when_ a job runs.
A trigger does not know _how_ to run a job; it receives a `run` function.

```ts
import { intervalTrigger } from '@stepflow/integration';

const handle = await intervalTrigger(60_000).start(() =>
  runJob(ordersSync, { page, repository, params: { since: '2026-06-01' } }),
);

// later
await handle.stop();
```

Use `createManualTrigger()` for tests, CLI commands, or hand-operated runs.

## Packages

| Package                    | Purpose                                                                      | Published |
| -------------------------- | ---------------------------------------------------------------------------- | --------- |
| `stepflow`                 | Umbrella: re-exports core + puppeteer + infrastructure for a single install. | yes       |
| `@stepflow/core`           | Job builder, execution engine, metadata model, and in-memory repository.     | yes       |
| `@stepflow/infrastructure` | Durable `JobRepository` adapters: MySQL and SQLite, with schemas.            | yes       |
| `@stepflow/integration`    | Trigger seam plus manual and interval trigger implementations.               | yes       |
| `@stepflow/puppeteer`      | Bounded page pool and parallel job runner with per-job timeout cancellation. | yes       |
| `@stepflow/test`           | Repository contract suite, recording listener, and Puppeteer `Page` doubles. | yes       |
| `@stepflow/samples`        | Reference jobs used by the monorepo.                                         | private   |
| `@stepflow/docs`           | Design docs and generated API reference.                                     | private   |

## Development

This repository is an npm workspaces monorepo.

```sh
npm install
npm run check          # typecheck + lint + test
npm run build          # dual ESM/CJS + declaration output
npm run test:coverage  # coverage thresholds where applicable
npm run format:check
```

SQLite repository tests run in-memory on every invocation. MySQL repository tests
are opt-in:

```sh
MYSQL_URL='mysql://user:pass@localhost:3306/stepflow' npm run test -w @stepflow/infrastructure
```

Release metadata is managed with Changesets:

```sh
npm run changeset
npm run version-packages
npm run release
```

## Design

Read [the design doc](stepflow-docs/design.md) for the restart model and metadata
schema.

## License

MIT
