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
   * Snapshotted to the repository at each successful step boundary and restored
   * on restart, so steps skipped during restart still hand their data forward.
   *
   * Values MUST be JSON-serializable (the persistence boundary is JSON): a
   * `Date` round-trips back as a string, and `undefined`/function values are
   * dropped. Both shipped repositories normalize identically.
   */
  readonly shared: Record<string, unknown>;
  readonly logger: Logger;
  /**
   * Cooperative cancellation signal (a standard `AbortSignal`, not a Puppeteer
   * type). Present when the caller supplies one (e.g. a parallel pool enforcing a
   * per-job timeout). Steps should forward it to Puppeteer calls that accept a
   * `signal` so a deadline aborts them promptly; stepflow itself never cancels or
   * closes the browser — that is the caller's responsibility.
   */
  readonly signal?: AbortSignal;
}

/** The body of a step. */
export type StepRun = (ctx: StepContext) => Promise<void | ExitStatus>;

/** A single named unit of work within a job. */
export interface Step {
  readonly name: string;
  readonly run: StepRun;
}

/**
 * Yields the items a chunk step processes, in a **deterministic** order. The
 * engine re-reads the full sequence on restart and skips the already-committed
 * prefix, so the reader must reproduce the same order every run.
 */
export type ChunkReader<T> = (ctx: StepContext) => AsyncIterable<T> | Iterable<T>;

/** Transforms a read item before it is written. Omit to write items unchanged. */
export type ChunkProcessor<T, R> = (item: T, ctx: StepContext) => R | Promise<R>;

/** Writes (commits) one chunk of processed items. Should be idempotent (at-least-once on crash). */
export type ChunkWriter<R> = (items: readonly R[], ctx: StepContext) => void | Promise<void>;

/** Configuration for {@link JobBuilder.chunkStep}. */
export interface ChunkStepConfig<T, R> {
  /** Items committed per chunk (must be >= 1). */
  readonly chunkSize: number;
  readonly reader: ChunkReader<T>;
  readonly processor?: ChunkProcessor<T, R>;
  readonly writer: ChunkWriter<R>;
}

/**
 * A chunk-oriented step: read → process → write in committed chunks of
 * `chunkSize`, checkpointing the committed offset so a restart resumes after the
 * last committed chunk. The stored form is type-erased; {@link JobBuilder.chunkStep}
 * preserves item/result types at the call site.
 */
export interface ChunkStep {
  readonly name: string;
  readonly chunkSize: number;
  readonly reader: ChunkReader<unknown>;
  readonly processor?: ChunkProcessor<unknown, unknown>;
  readonly writer: ChunkWriter<unknown>;
}

/** Either kind of step that can appear in a job's flow. */
export type JobStep = Step | ChunkStep;
