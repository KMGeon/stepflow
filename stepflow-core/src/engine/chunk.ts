import { COMPLETED, FAILED } from '../types';
import type { ChunkStep, ExitStatus, JobStep, StepContext } from '../types';

/** Payload for {@link JobListener.onChunk}, emitted after each committed chunk. */
export interface ChunkInfo {
  readonly stepName: string;
  /** 1-based index of this chunk within the current run. */
  readonly chunkIndex: number;
  /** Number of items in this committed chunk. */
  readonly size: number;
  /** Items read (and processed) so far this run, excluding the skipped committed prefix. */
  readonly readCount: number;
  /** Items written so far this run. */
  readonly writeCount: number;
}

/** Outcome of running a chunk step (mirrors the simple-step fields the engine needs). */
export interface ChunkRunResult {
  readonly exitStatus: ExitStatus;
  readonly threw: boolean;
  readonly caughtError: unknown;
  readonly errorMessage: string | undefined;
  readonly readCount: number;
  readonly writeCount: number;
}

/** Narrow a {@link JobStep} to a {@link ChunkStep}. */
export function isChunkStep(step: JobStep): step is ChunkStep {
  return 'reader' in step;
}

/**
 * Run a chunk step: read the deterministic item sequence, skip the prefix already
 * committed in a prior run (from `checkpoints`, keyed by step name), then
 * process/write/commit in chunks of `chunkSize`. Each commit advances
 * `checkpoints[step.name]` and persists it via `persistCheckpoint`, so a later
 * failure still resumes after the last commit.
 *
 * `checkpoints` is an engine-private store (persisted under its own context owner),
 * NOT the user `ctx.shared` bag — so it neither leaks to user steps nor can be
 * spoofed by a user key.
 *
 * `at-least-once`: a crash between a writer commit and the checkpoint persist may
 * re-process the last chunk on restart, so writers should be idempotent.
 */
export async function runChunkStep(
  step: ChunkStep,
  ctx: StepContext,
  checkpoints: Record<string, number>,
  deps: {
    persistCheckpoint: () => Promise<void>;
    emitChunk: (info: ChunkInfo) => Promise<void>;
  },
): Promise<ChunkRunResult> {
  const startCommitted = checkpoints[step.name] ?? 0;
  let committed = startCommitted;
  let readCount = 0;
  let writeCount = 0;
  let chunkIndex = 0;
  let buffer: unknown[] = [];
  let rawIndex = 0;

  const commit = async (): Promise<void> => {
    await step.writer(buffer, ctx);
    committed += buffer.length;
    writeCount += buffer.length;
    chunkIndex += 1;
    checkpoints[step.name] = committed;
    await deps.persistCheckpoint();
    await deps.emitChunk({
      stepName: step.name,
      chunkIndex,
      size: buffer.length,
      readCount,
      writeCount,
    });
    buffer = [];
  };

  try {
    for await (const item of step.reader(ctx)) {
      rawIndex += 1;
      if (rawIndex <= startCommitted) {
        continue; // already committed in a prior run
      }
      readCount += 1;
      const processed = step.processor ? await step.processor(item, ctx) : item;
      buffer.push(processed);
      if (buffer.length >= step.chunkSize) {
        await commit();
      }
    }
    if (buffer.length > 0) {
      await commit();
    }
    return {
      exitStatus: COMPLETED,
      threw: false,
      caughtError: undefined,
      errorMessage: undefined,
      readCount,
      writeCount,
    };
  } catch (error) {
    return {
      exitStatus: FAILED,
      threw: true,
      caughtError: error,
      errorMessage: error instanceof Error ? error.message : String(error),
      readCount,
      writeCount,
    };
  }
}
