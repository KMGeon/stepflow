# stepflow

<p align="center">
  <img src="assets/stepflow.png" alt="stepflow" width="760" />
</p>

[![npm](https://img.shields.io/npm/v/@stepflow/core?label=%40stepflow%2Fcore)](https://www.npmjs.com/package/@stepflow/core)
[![license](https://img.shields.io/npm/l/@stepflow/core)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-339933)](package.json)
[![typescript](https://img.shields.io/badge/TypeScript-strict-3178c6)](tsconfig.base.json)

Declarative Puppeteer RPA jobs with Spring Batch-style metadata, restart, and
execution history.

`stepflow` helps you turn fragile browser automation scripts into restartable
batch jobs. Define a job as named steps, run it against a Puppeteer `page`, and
persist execution metadata so failed jobs resume from the step that failed
instead of repeating work that already completed.

```ts
const result = await runJob(ordersSync, {
  page,
  repository,
  params: { since: '2026-06-01' },
});

// { instanceId, executionId, status, exitStatus, restarted }
```

## Why stepflow?

- **Restart from failure**: failed executions resume from the failed step with
  shared execution context restored.
- **Spring Batch model, browser-first**: Job, Step, JobRepository, JobInstance,
  JobExecution, StepExecution, and ExecutionContext adapted for Puppeteer RPA.
- **You own runtime resources**: stepflow never launches a browser or owns a DB
  connection. Inject the Puppeteer `page` and repository you want.
- **Composable packages**: install only the core runtime, then add persistence,
  triggers, or test utilities when needed.
- **TypeScript-native**: strict types, dual ESM/CJS output, and small public
  APIs.

## Install

```sh
npm install @stepflow/core puppeteer
```

Add durable metadata storage when you need restart across processes:

```sh
npm install @stepflow/infrastructure mysql2
```

Add trigger adapters for manual or scheduled runs:

```sh
npm install @stepflow/integration
```

`puppeteer` and `mysql2` are peer dependencies. Your application owns the
browser lifecycle and database connection pool.

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
  params: {
    username: process.env.USERNAME,
    password: process.env.PASSWORD,
    since: '2026-06-01',
  },
});

await browser.close();

console.log(result.status, result.exitStatus);
```

Steps run in registration order when they return `COMPLETED`. A `.branch()`
overrides the next step for specific exit statuses. A step fails when it throws
or returns `FAILED`; `runJob` returns a failed result instead of throwing for
job-level failure.

## Durable Restart

Use `@stepflow/infrastructure` when executions need to survive process restarts.

```ts
import { MySqlJobRepository } from '@stepflow/infrastructure';
import mysql from 'mysql2/promise';

const pool = mysql.createPool(process.env.MYSQL_URL);
const repository = new MySqlJobRepository(pool);

await runJob(ordersSync, {
  page,
  repository,
  params: { since: '2026-06-01' },
});
```

Apply `@stepflow/infrastructure/schema.sql` once before using the MySQL
repository. Re-running the same job with the same identifying `params` resumes
the previous failed instance from the failed step and restores the shared
`ExecutionContext`.

## Triggers

`@stepflow/integration` provides the trigger seam for deciding when a job runs.
Triggers do not know how to execute a job; they receive a `run` function from
your application.

```ts
import { intervalTrigger } from '@stepflow/integration';

const trigger = intervalTrigger(60_000);

const handle = await trigger.start(() =>
  runJob(ordersSync, {
    page,
    repository,
    params: { since: '2026-06-01' },
  }),
);

// later
await handle.stop();
```

Use `createManualTrigger()` for tests, CLI commands, or hand-operated runs.

## Packages

| Package                    | Purpose                                                                      | Published |
| -------------------------- | ---------------------------------------------------------------------------- | --------- |
| `@stepflow/core`           | Job builder, execution engine, metadata model, and in-memory repository.     | yes       |
| `@stepflow/infrastructure` | MySQL `JobRepository` adapter and schema.                                    | yes       |
| `@stepflow/integration`    | Trigger contracts plus manual and interval trigger implementations.          | yes       |
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

MySQL repository tests are opt-in:

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

Read [the design doc](stepflow-docs/design.md) for the restart model, metadata
schema, and Spring Batch mapping.

## License

MIT
