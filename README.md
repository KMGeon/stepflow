# stepflow

> Declarative Puppeteer RPA batch runtime with Spring Batch-style metadata, restart, and execution history.

stepflow lets you define a browser automation **job** as a chain of **steps**, run
it on an injected Puppeteer `page`, and persist every run's metadata so a failed
job can **restart from the step it failed on** — skipping the work that already
succeeded. The model mirrors Spring Batch (Job / Step / JobRepository /
JobInstance / ExecutionContext), adapted to the browser-RPA domain.

## Packages

| Package                    | What it is                                                                                     | Published |
| -------------------------- | ---------------------------------------------------------------------------------------------- | --------- |
| `@stepflow/core`           | Builder, execution engine, metadata model, and the in-memory `JobRepository`. No runtime deps. | ✅        |
| `@stepflow/infrastructure` | MySQL `JobRepository` adapter (`mysql2` peer) + schema.                                        | ✅        |
| `@stepflow/test`           | Test utilities: the `JobRepository` contract suite and a Puppeteer `Page` double.              | ✅        |
| `@stepflow/samples`        | Generic reference jobs.                                                                        | private   |
| `@stepflow/docs`           | Design docs and generated API reference.                                                       | private   |

You only install what you use. The default path — `@stepflow/core` with the
built-in in-memory repository — has **no database dependency**.

## Install

```sh
npm install @stepflow/core puppeteer
# add persistence when you need it:
npm install @stepflow/infrastructure mysql2
```

`puppeteer` and `mysql2` are peer dependencies — stepflow never launches a
browser or owns a connection; you inject the `page` and the connection pool.

## Quick start

```ts
import { defineJob, runJob, InMemoryJobRepository } from '@stepflow/core';

const job = defineJob('orders_sync')
  .step('login', async (ctx) => {
    await ctx.page.goto('https://example.com/login');
    // ...
  })
  .step('parse', async (ctx) => {
    const count = await ctx.page.$$eval('#orders tr', (rows) => rows.length);
    ctx.shared.count = count;
    return count > 0 ? 'COMPLETED' : 'EMPTY'; // custom exit status drives branching
  })
  .step('confirm', async (ctx) => {
    /* ... */
  })
  .step('cleanup', async (ctx) => {
    /* ... */
  })
  .branch('parse', { EMPTY: 'cleanup' }) // only the non-linear edge needs declaring
  .build();

const browser = await puppeteer.launch();
const page = await browser.newPage();

const result = await runJob(job, {
  page, // you own the browser; stepflow drives the page
  repository: new InMemoryJobRepository(),
  params: { since: '2026-06-01' },
});
// result: { instanceId, executionId, status, exitStatus, restarted }
```

Steps run in registration order on `COMPLETED`; `.branch()` overrides transitions
for specific exit statuses. A step **fails** when it throws or returns the
`FAILED` exit status. `runJob` does not throw on step failure — it returns a
result with `status: 'FAILED'` (Spring Batch `JobLauncher` semantics).

### Persistence and restart

```ts
import { MySqlJobRepository } from '@stepflow/infrastructure';
import mysql from 'mysql2/promise';

const repository = new MySqlJobRepository(mysql.createPool(process.env.MYSQL_URL));
// Apply @stepflow/infrastructure/schema.sql once, then:
await runJob(job, { page, repository, params: { since: '2026-06-01' } });
```

Re-running a job with the same identifying `params` resumes a failed run from
the step it failed on, restoring the shared `ExecutionContext`. See
[the design doc](packages/docs/design.md) for the full restart model and the
schema.

## Development

This is an npm-workspaces monorepo.

```sh
npm install
npm run typecheck   # all packages
npm run lint
npm run test        # all packages (MySQL tests are opt-in via MYSQL_URL)
npm run build       # dual ESM + CJS + d.ts per package
```

## License

MIT
