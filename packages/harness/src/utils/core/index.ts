/**
 * Core utilities: browser-safe path basics, abort and failure helpers, and
 * id minting.
 *
 * NOTE: pathCore stays a separate module because it depends on Node.js
 * 'path' while this file is reached from browser code through
 * `@texra-ai/harness/schemas`. The path helpers here (normalizeFilePath,
 * getBasename, getFileStem) build on 'pathe' — a dependency-free,
 * browser-safe reimplementation of node:path. Anything needing real
 * filesystem-path semantics (containment, `.`/`..` resolution) should
 * import from '@utils/core/pathCore' instead.
 */
import { customAlphabet, nanoid } from 'nanoid';
import { basename as pathBasename, extname as pathExtname } from 'pathe';

import type { RunId } from '@shared/schemas';

// ---------------------------------------------------------------------------
// pathBasics (browser-safe; Node-dependent path helpers live in pathCore.ts)
// ---------------------------------------------------------------------------

/**
 * Normalize a file path to forward slashes for consistent comparisons.
 */
export function normalizeFilePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

/**
 * Extract the base name (filename) from a file path.
 * Handles platform-specific separators (\ on Windows, / on Unix).
 *
 * @example
 * getBasename('/home/user/document.pdf') // returns 'document.pdf'
 * getBasename('C:\\Users\\file.txt')     // returns 'file.txt'
 * getBasename('/path/to/')               // returns 'to'
 * getBasename('/')                       // returns ''
 */
export function getBasename(filePath: string | undefined | null): string {
  if (!filePath) return '';
  return pathBasename(normalizeFilePath(filePath));
}

/**
 * Basename without its final extension (`'notes'` for `'dir/notes.md'`).
 * Dotfiles keep their name (`'.gitignore'` → `'.gitignore'`).
 */
export function getFileStem(filePath: string | undefined | null): string {
  const base = getBasename(filePath);
  // pathe's extname() misreads a dotfile's leading dot as an extension
  // marker once a directory prefix is present (e.g. '/home/user/.bashrc'),
  // even though it gets bare '.bashrc' right — so compute it against the
  // basename alone, never the full path.
  return pathBasename(base, pathExtname(base));
}

// ---------------------------------------------------------------------------
// async
// ---------------------------------------------------------------------------

/**
 * Register an abort handler, firing it immediately if `signal` is already
 * aborted (an `addEventListener` after the fact never fires on its own).
 * Returns a disposer that detaches the listener; safe to call even after the
 * handler already fired. No-ops when `signal` is undefined.
 */
export function onAbort(
  signal: AbortSignal | undefined,
  fn: () => void,
): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    fn();
    return () => {};
  }
  signal.addEventListener('abort', fn, { once: true });
  return () => signal.removeEventListener('abort', fn);
}

/**
 * Reduce a NON-EMPTY failure list to the value to throw: the lone failure
 * unwrapped when there is exactly one, or an {@link AggregateError} carrying
 * `message` when there are several. Use as `throw aggregateError(...)` where a
 * failure is guaranteed, or to build an error for a `cause`.
 */
export function aggregateError(
  failures: readonly unknown[],
  message: string,
): unknown {
  return failures.length === 1
    ? failures[0]
    : new AggregateError(failures, message);
}

// ---------------------------------------------------------------------------
// backoff
// ---------------------------------------------------------------------------

const JITTER_FRACTION = 0.2;

/**
 * Compute a jittered exponential backoff delay: `baseMs * 2^(failures-1)`,
 * capped at `maxMs`, then randomized by +/-20% and capped again
 * so jitter can never push the result past `maxMs`. Shared by every retry/
 * backoff loop in the codebase so the jitter formula only exists once.
 *
 * `unitRandom` is the caller's uniform draw in [0, 1) — `yield* Random.next`
 * in the Effect callers — so a test fixes the jitter through Effect's
 * `Random` reference instead of stubbing the global `Math.random`.
 */
export function jitteredExponentialBackoffMs(
  baseMs: number,
  failures: number,
  maxMs: number,
  unitRandom: number,
): number {
  const exponential = Math.min(
    maxMs,
    Math.max(0, baseMs) * 2 ** Math.max(0, failures - 1),
  );
  const jitter = 1 - JITTER_FRACTION + unitRandom * 2 * JITTER_FRACTION;
  return Math.min(maxMs, Math.round(exponential * jitter));
}

// ---------------------------------------------------------------------------
// runId
// ---------------------------------------------------------------------------

/** Generate a 12-char lowercase-hex ID (48 bits of entropy). */
const hexId12 = customAlphabet('0123456789abcdef', 12);

/** Mint a run id: 12 lowercase hex chars (48 bits of entropy). One of the
 *  two minting sites (`deriveRunId` is the other), so the brand is
 *  applied here and nowhere downstream. */
export function generateRunId(): RunId {
  return hexId12() as RunId;
}

/**
 * Generate a short unique ID for non-schema-constrained uses (temp
 * filenames, log entry IDs): nanoid's standard 21-char URL-safe alphabet.
 * A run id, which its schema constrains to lowercase hex, is
 * `generateRunId`'s.
 */
export function generateShortId(): string {
  return nanoid();
}
