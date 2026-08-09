/**
 * Core utilities - consolidated type, async, comparator, math, url, id,
 * path-basics, and semaphore helpers. Formerly one file per concern in this
 * folder.
 *
 * NOTE: pathCore stays a separate module because it depends on Node.js
 * 'path' while this file is used by webview frontend code (browser context).
 * The path helpers here (normalizeFilePath, getBasename, getFileStem) build
 * on 'pathe' — a dependency-free, browser-safe reimplementation of
 * node:path — so they're safe for both browser and backend callers.
 * Anything needing real filesystem-path semantics (segment traversal,
 * `.`/`..` resolution) should import from '@utils/core/pathCore' instead.
 *
 * String validation/formatting primitives live in @utils/text/stringUtils
 * (the single home for generic string helpers) and are re-exported here for
 * existing @utils/core consumers.
 */
import { customAlphabet, nanoid } from 'nanoid';
import { basename as pathBasename, extname as pathExtname } from 'pathe';

import type { ExecutionId } from '@shared/schemas';

export {
  isNonEmptyString,
  isString,
  formatCompactDuration,
  formatCompactTokenCount,
  formatDuration,
  formatWallTimeSeconds,
  serializeError,
} from '../text/stringUtils';
export { KeyedMutex } from './keyedMutex';

// ---------------------------------------------------------------------------
// typeGuards
// ---------------------------------------------------------------------------

/**
 * Type guards for common value structures.
 */

/** Check if value is a non-null object (not array). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Check if value is a finite number (excludes NaN and ±Infinity). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Check if a value is a thenable (has a callable `.then`). */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null)?.then === 'function';
}

/** Predicate for filtering null values from arrays while narrowing the element type. */
export function filterNotNull<T>(item: T | null): item is T {
  return item !== null;
}

/** Predicate for filtering null and undefined values from arrays while narrowing the element type. */
export function filterNotNullish<T>(item: T | null | undefined): item is T {
  return item != null;
}

/** Wrap a single value in an array, or return the array unchanged. */
export function ensureArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

/** Return a new array with duplicate values removed, preserving first-occurrence order. */
export function unique<T>(iterable: Iterable<T>): T[] {
  return [...new Set(iterable)];
}

/**
 * Bucket items into a `Map<K, V[]>` keyed by `keyFn`, preserving each
 * bucket's first-occurrence insertion order. `valueFn` maps each item to
 * the value stored in its bucket (defaults to the item itself). Equivalent
 * to the upcoming `Map.groupBy`, kept as a helper because the repo's `lib`
 * target (ES2023) doesn't declare it yet.
 */
export function groupBy<T, K, V = T>(
  items: readonly T[],
  keyFn: (item: T) => K,
  valueFn?: (item: T) => V,
): Map<K, V[]> {
  const groups = new Map<K, V[]>();
  for (const item of items) {
    const key = keyFn(item);
    const value = valueFn ? valueFn(item) : (item as unknown as V);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(value);
    } else {
      groups.set(key, [value]);
    }
  }
  return groups;
}

/**
 * Serialize a Map to a plain Record object. Keys are stringified.
 * @example mapToRecord(new Map([['a', 1]])) // { a: 1 }
 */
export function mapToRecord<K extends string | number, V>(
  map: Map<K, V>,
): Record<string, V> {
  return Object.fromEntries(
    [...map].map(([key, value]) => [String(key), value]),
  );
}

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
 * Basename without its final extension (`'paper'` for `'dir/paper.tex'`).
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

/** Exhaustiveness helper for discriminated unions. Call in the `default` branch of a switch. */
export function assertNever(value: never, message: string): never {
  const detail =
    typeof value === 'string' ? value : JSON.stringify(value, undefined, 2);
  throw new Error(`${message}: ${detail}`);
}

// ---------------------------------------------------------------------------
// async
// ---------------------------------------------------------------------------

// Re-export debounce from perfect-debounce for consistent usage across codebase
export { debounce } from 'perfect-debounce';

// AbortSignal-aware sleep shared by extension, CLI, and webview code.
export { default as delay } from 'delay';

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
 * A trailing-edge timer batcher with a synchronous flush escape hatch —
 * perfect-debounce's `debounce()` only exposes `cancel()` (discard the
 * pending call), with no way to force the trailing call to run early.
 * Several call sites need exactly that: run the pending work synchronously
 * right now (typically just before teardown/dispose), instead of either
 * waiting out the timer or dropping the work.
 *
 * `schedule()` always (re)starts the timer, matching a classic trailing
 * debounce. A call site that instead wants "start once, coalesce further
 * calls until it fires" (a throttle-style batching window) can guard with
 * `pending`: `if (!batcher.pending) batcher.schedule();`.
 *
 * The timer handle is cleared *before* the callback runs, so a `schedule()`
 * made from inside the callback opens a fresh window that this invocation's
 * own cleanup cannot cancel. Re-entrancy is not hypothetical: the CLI's
 * transcript sync flushes buffered trace chunks into the store from inside
 * its own callback, which synchronously re-schedules. A library debounce
 * that invokes and then cancels (es-toolkit's does) silently drops that
 * reschedule and leaves `pending` stuck true, freezing every later update.
 *
 * The callback is fixed at creation and takes no arguments — call sites that
 * need per-invocation data close over their own mutable state (as the
 * original hand-rolled versions already did) and read it when the callback
 * fires, rather than threading arguments through the timer.
 */
export interface FlushableDebounce {
  /** (Re)start the timer; invokes the callback after `waitMs` of inactivity. */
  schedule(): void;
  /**
   * If a call is pending, invoke the callback synchronously right now and
   * clear the timer. No-op when nothing is pending.
   */
  flush(): void;
  /** Clear the pending timer without invoking the callback. No-op when nothing is pending. */
  cancel(): void;
  /** True while a call is scheduled and hasn't fired, flushed, or been cancelled yet. */
  readonly pending: boolean;
}

export function createFlushableDebounce(
  callback: () => void,
  waitMs: number,
): FlushableDebounce {
  let timer: ReturnType<typeof setTimeout> | undefined;

  function cancel(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  function invoke(): void {
    timer = undefined;
    callback();
  }

  return {
    schedule() {
      cancel();
      timer = setTimeout(invoke, waitMs);
    },
    flush() {
      if (timer === undefined) return;
      cancel();
      invoke();
    },
    cancel,
    get pending() {
      return timer !== undefined;
    },
  };
}

/**
 * Coalesce concurrent async requests for the same key: return a resolved
 * value from `resolved` if present, otherwise share one in-flight promise
 * per key via `pending` so concurrent callers await the same computation.
 * Only caches the result (and clears the in-flight entry) if `pending`
 * still points at this exact promise once it settles — this guards against
 * an external `pending.clear()`/`resolved.clear()` invalidation racing the
 * in-flight computation, which would otherwise let a stale result get
 * cached after the fact.
 *
 * `resolved` is the minimal read/write cache shape satisfied by LRUCache
 * and plain Maps.
 */
export async function coalesceAsync<Key, Value>(
  resolved: {
    get(key: Key): Value | undefined;
    set(key: Key, value: Value): void;
  },
  pending: Map<Key, Promise<Value>>,
  key: Key,
  compute: () => Promise<Value>,
): Promise<Value> {
  const cached = resolved.get(key);
  if (cached !== undefined) return cached;

  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const request = compute();
  pending.set(key, request);

  try {
    const value = await request;
    if (pending.get(key) === request) {
      resolved.set(key, value);
    }
    return value;
  } finally {
    if (pending.get(key) === request) {
      pending.delete(key);
    }
  }
}

/**
 * Rethrow a collected set of independent failures with the conventional
 * shape: a no-op when empty, the single error unwrapped when there is exactly
 * one, and an {@link AggregateError} carrying `message` when there are
 * several. Centralizes the "run each teardown step, collect what threw, then
 * surface them together" tail that session and run shutdown paths repeat.
 */
export function throwAggregated(
  failures: readonly unknown[],
  message: string,
): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

// ---------------------------------------------------------------------------
// comparators
// ---------------------------------------------------------------------------

/**
 * Reusable sort comparator functions for use with Array.sort / Array.toSorted.
 */

/** Alphabetically compare two objects by their `name` property. */
export function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name);
}

/** Alphabetically compare two strings directly — pass as `.sort(byString)`. */
export function byString(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * Build a comparator that alphabetically sorts objects by a derived string.
 * @example `.sort(byStringProp(t => t.path))`
 */
export function byStringProp<T>(fn: (t: T) => string): (a: T, b: T) => number {
  return (a, b) => fn(a).localeCompare(fn(b));
}

/**
 * Return a new array ordered by newest timestamp first.
 * Each timestamp is parsed once before sorting.
 */
export function toNewestFirstByTimestamp<T>(
  items: readonly T[],
  timestampOf: (item: T) => string,
): T[] {
  return items
    .map((item) => ({ item, key: Date.parse(timestampOf(item)) }))
    .sort((a, b) => b.key - a.key)
    .map(({ item }) => item);
}

// ---------------------------------------------------------------------------
// math
// ---------------------------------------------------------------------------

/**
 * Clamp `value` to the inclusive range [`min`, `max`].
 * When `min > max` the lower bound wins and the result equals `min`.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Clamp `value` to optional bounds. Each bound is applied only when defined.
 * Equivalent to `clamp` when both are provided and `min <= max`; a no-op when neither is.
 */
export function clampOptional(
  value: number,
  min?: number,
  max?: number,
): number {
  let result = value;
  if (min != null) result = Math.max(min, result);
  if (max != null) result = Math.min(max, result);
  return result;
}

/**
 * Clamp `index` into `[0, length - 1]`.
 * Returns 0 when `length <= 0` so the result is always a valid array index.
 */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return clamp(index, 0, length - 1);
}

/**
 * Round `value` to `decimals` decimal places, returning a number.
 * Equivalent to `Number(value.toFixed(decimals))` but expresses intent clearly.
 */
export function roundTo(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

/**
 * Compute a jittered exponential backoff delay: `baseMs * 2^(failures-1)`,
 * capped at `maxMs`, then randomized by `+/-jitterFraction` and capped again
 * so jitter can never push the result past `maxMs`. Shared by every retry/
 * backoff loop in the codebase so the jitter formula only exists once.
 */
export function jitteredExponentialBackoffMs(
  baseMs: number,
  failures: number,
  maxMs: number,
  jitterFraction = 0.2,
): number {
  const exponential = Math.min(
    maxMs,
    Math.max(0, baseMs) * 2 ** Math.max(0, failures - 1),
  );
  const jitter = 1 - jitterFraction + Math.random() * 2 * jitterFraction;
  return Math.min(maxMs, Math.round(exponential * jitter));
}

// ---------------------------------------------------------------------------
// urlCore
// ---------------------------------------------------------------------------

/**
 * Parse a URL string, returning `undefined` instead of throwing on invalid
 * input. Centralizes the `new URL(...)` guard so callers don't each need a
 * try/catch. Browser-safe (URL is a web standard global).
 */
export function tryParseUrl(input: string): URL | undefined {
  try {
    return new URL(input);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// executionId
// ---------------------------------------------------------------------------

/**
 * Generate a 12-char lowercase-hex ID (48 bits of entropy). Shared by
 * schemas that constrain IDs to hex (execution IDs, inquiry thread IDs,
 * goal IDs).
 */
export const hexId12 = customAlphabet('0123456789abcdef', 12);

/** Generate a compact 12-char hex execution ID (48 bits of entropy). */
export function generateExecutionId(): ExecutionId {
  return hexId12() as ExecutionId;
}

/**
 * Generate a short unique ID for non-schema-constrained uses (temp
 * filenames, log entry IDs). Defaults to nanoid's standard 21-char
 * URL-safe alphabet; pass `size` for a shorter ID. Use {@link hexId12}
 * instead when a schema constrains the ID to lowercase hex.
 */
export function generateShortId(size?: number): string {
  return nanoid(size);
}
