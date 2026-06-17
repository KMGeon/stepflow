import type { Page } from 'puppeteer';

import {
  defineJob,
  runJob,
  type JobParameters,
  type JobRepository,
  type RunJobResult,
} from '@kmgeon/stepflow';

/**
 * Generic reference job: sign in to a storefront and confirm recent orders.
 *
 * Demonstrates linear `.step()` chaining, a `.branch()` for the empty-result
 * case, `params`, the shared ExecutionContext, and a restart-friendly shape
 * (a fresh `login` re-establishes the session restart cannot restore). The site
 * is fictional; wire the job to a live page and metadata store via
 * {@link runOrdersSync}.
 */
export const ordersSync = defineJob('orders_sync')
  .step('login', async (ctx) => {
    ctx.logger.info('signing in');
    await ctx.page.goto('https://example.com/login', { waitUntil: 'networkidle2' });
    await ctx.page.type('#username', ctx.params.username ?? '');
    await ctx.page.type('#password', ctx.params.password ?? '');
    await Promise.all([ctx.page.click('#sign-in'), ctx.page.waitForNavigation()]);
  })
  .step('search', async (ctx) => {
    const since = ctx.params.since ?? '2026-06-01';
    await ctx.page.goto(`https://example.com/orders?since=${since}`);
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
    await ctx.page.click('#confirm');
    await ctx.page.waitForSelector('#confirm-done');
  })
  .step('cleanup', async (ctx) => {
    ctx.logger.info('no orders to confirm; cleaning up');
    await ctx.page.goto('https://example.com/');
  })
  // Only the non-linear edge needs declaring: an empty result skips `confirm`.
  .branch('parse', { EMPTY: 'cleanup' })
  .build();

/** Wire the job to a live page and metadata store. */
export function runOrdersSync(
  page: Page,
  repository: JobRepository,
  params: JobParameters = {},
): Promise<RunJobResult> {
  return runJob(ordersSync, { page, repository, params });
}
