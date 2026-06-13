import type { Browser, Page } from 'puppeteer';

/**
 * A step's terminal exit status. Drives flow transitions.
 *
 * `'COMPLETED'` and `'FAILED'` are produced by the engine for normal return and
 * thrown errors respectively; any other string is a custom status a step returns
 * to drive branching (e.g. `'EMPTY'`).
 */
export type ExitStatus = 'COMPLETED' | 'FAILED' | (string & {});

/** Well-known exit statuses the engine produces automatically. */
export const COMPLETED = 'COMPLETED';
export const FAILED = 'FAILED';

/**
 * Lifecycle status of a job or step execution (Spring Batch `BatchStatus`).
 * Distinct from {@link ExitStatus}, which is user-controllable and drives flow.
 */
export type BatchStatus = 'STARTED' | 'COMPLETED' | 'FAILED';

/** Job parameters supplied per run. Identifying params form the instance identity. */
export type JobParameters = Readonly<Record<string, string>>;

/** Minimal structured logger contract. stepflow depends only on this interface. */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Execution context handed to every step's {@link Step.run}. */
export interface StepContext {
  readonly jobName: string;
  /** JobInstance id (jobName + identifying-params hash). */
  readonly instanceId: number;
  /** This JobExecution's id. */
  readonly executionId: number;
  readonly params: JobParameters;
  /** Injected Puppeteer Page. stepflow never launches a browser. */
  readonly page: Page;
  /** Injected Puppeteer Browser, for steps that open additional tabs. */
  readonly browser?: Browser;
  /**
   * Job-level ExecutionContext: a mutable key-value bag shared across steps.
   * Snapshotted to the repository at each step boundary and restored on restart,
   * so steps skipped during restart still hand their data forward.
   */
  readonly shared: Record<string, unknown>;
  readonly logger: Logger;
}

/** The body of a step. */
export type StepRun = (ctx: StepContext) => Promise<void | ExitStatus>;

/** A single named unit of work within a job. */
export interface Step {
  readonly name: string;
  readonly run: StepRun;
}
