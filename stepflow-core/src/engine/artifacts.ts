import type { Page } from 'puppeteer';

/** A snapshot captured when a step finally fails, handed to {@link ArtifactSink}. */
export interface FailureArtifact {
  readonly jobName: string;
  readonly executionId: number;
  readonly stepName: string;
  /** 1-based sequence number of the step in the job definition. */
  readonly seqNo: number;
  readonly error: string;
  readonly url: string;
  /** PNG bytes from `page.screenshot()`; empty if the capture failed. */
  readonly screenshot: Uint8Array;
  /** `page.content()` DOM dump; empty string if the capture failed. */
  readonly html: string;
  /** Console/page-error lines collected during the step (empty until console capture lands). */
  readonly consoleLogs: readonly string[];
  /** epoch ms when captured. */
  readonly capturedAt: number;
}

/** Receives a failure artifact. The consumer owns storage (file/S3/DB). */
export type ArtifactSink = (artifact: FailureArtifact) => void | Promise<void>;

/** Metadata the engine knows about the failing step, merged into the artifact. */
export interface FailureArtifactMeta {
  readonly jobName: string;
  readonly executionId: number;
  readonly stepName: string;
  readonly seqNo: number;
  readonly error: string;
}

/** A Puppeteer ConsoleMessage exposes `text()`; we only need that here. */
interface ConsoleLike {
  text(): string;
}

/**
 * Subscribe to a page's `console`/`pageerror` events and buffer their text.
 * Returns the live buffer and a `detach` to unsubscribe at step end.
 */
export function attachConsoleCapture(page: Page): { logs: string[]; detach(): void } {
  const logs: string[] = [];
  const onConsole = (msg: ConsoleLike): void => {
    logs.push(msg.text());
  };
  const onPageError = (err: Error): void => {
    logs.push(err.message);
  };
  // Puppeteer's typed overloads don't accept a bare string here; the page double
  // and runtime both key off the event name, so cast through a minimal shape.
  const emitter = page as unknown as {
    on(event: string, cb: (arg: unknown) => void): void;
    off(event: string, cb: (arg: unknown) => void): void;
  };
  emitter.on('console', onConsole);
  emitter.on('pageerror', onPageError);
  return {
    logs,
    detach: () => {
      emitter.off('console', onConsole);
      emitter.off('pageerror', onPageError);
    },
  };
}

/**
 * Best-effort capture: each of screenshot/html/url is independent, so a failure
 * in one still yields the others. Never throws — capture must not mask the
 * original step failure.
 */
export async function captureFailureArtifact(
  page: Page,
  meta: FailureArtifactMeta,
  consoleLogs: readonly string[],
  now: () => number,
): Promise<FailureArtifact> {
  let url = '';
  let screenshot = new Uint8Array();
  let html = '';
  try {
    url = page.url();
  } catch {
    /* best-effort */
  }
  try {
    screenshot = await page.screenshot();
  } catch {
    /* best-effort */
  }
  try {
    html = await page.content();
  } catch {
    /* best-effort */
  }
  return { ...meta, url, screenshot, html, consoleLogs, capturedAt: now() };
}
