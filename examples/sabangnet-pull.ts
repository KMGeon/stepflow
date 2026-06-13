import type { Page } from 'puppeteer';

import {
  defineJob,
  runJob,
  type JobParameters,
  type JobRepository,
  type RunJobResult,
} from '../src/index';

/**
 * Reference port of agent-server's `sabangnet_pull` RPA job to stepflow.
 *
 * Demonstrates linear `.step()` chaining, a `.branch()` for the empty-result
 * case, `params`, the shared ExecutionContext, and a restart-friendly shape
 * (a fresh `login` re-establishes the session that restart cannot restore).
 * The step bodies sketch real Puppeteer usage; wire it to a live page and a
 * metadata store via {@link runSabangnetPull}.
 */
export const sabangnetPull = defineJob('sabangnet_pull')
  .step('login', async (ctx) => {
    ctx.logger.info('logging in to sabangnet');
    await ctx.page.goto('https://sabangnet.example/login', { waitUntil: 'networkidle2' });
    await ctx.page.type('#id', ctx.params.userId ?? '');
    await ctx.page.type('#pw', ctx.params.password ?? '');
    await Promise.all([ctx.page.click('#login'), ctx.page.waitForNavigation()]);
  })
  .step('search', async (ctx) => {
    const since = ctx.params.since ?? '2026-06-01';
    await ctx.page.goto(`https://sabangnet.example/orders?since=${since}`);
    await ctx.page.click('#search');
    await ctx.page.waitForSelector('#order-table');
  })
  .step('parse', async (ctx) => {
    const orderCount = await ctx.page.$$eval('#order-table tbody tr', (rows) => rows.length);
    ctx.shared.orderCount = orderCount;
    // Custom exit status drives the branch below.
    return orderCount > 0 ? 'COMPLETED' : 'EMPTY';
  })
  .step('confirm', async (ctx) => {
    ctx.logger.info(`confirming ${String(ctx.shared.orderCount)} orders`);
    await ctx.page.click('#select-all');
    await ctx.page.click('#confirm-orders');
    await ctx.page.waitForSelector('#confirm-done');
  })
  .step('cleanup', async (ctx) => {
    ctx.logger.info('no orders to confirm; cleaning up');
    await ctx.page.goto('https://sabangnet.example/home');
  })
  // Only the non-linear edge needs declaring: empty result skips `confirm`.
  .branch('parse', { EMPTY: 'cleanup' })
  .build();

/**
 * Wire the job to a live page and metadata store. The consumer owns the browser
 * (e.g. agent-server's stealth + serial-queue BrowserService); stepflow only
 * drives the injected page.
 */
export function runSabangnetPull(
  page: Page,
  repository: JobRepository,
  params: JobParameters = {},
): Promise<RunJobResult> {
  return runJob(sabangnetPull, { page, repository, params });
}
