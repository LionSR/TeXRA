/**
 * Shared timeout and HTTP-error helpers for tool implementations.
 *
 * Each tool defines its own timeout constant locally. This module only
 * provides the predicates that enforce a consistent error-classification
 * policy across tools (built around the `ky` HTTP client).
 */

import isNetworkError from 'is-network-error';
import { HTTPError, TimeoutError } from 'ky';
import { AbortError } from 'p-retry';

/**
 * Unwrap a p-retry {@link AbortError} to the original error it carried.
 *
 * Non-transient HTTP errors are wrapped in `new AbortError(error)` inside a
 * retry callback to stop retries. p-retry v8 already unwraps these — its
 * `onAttemptFailure` rethrows `error.originalError` — so the outer `catch`
 * normally receives the original error directly. This is a defensive safeguard
 * at the error-classification boundary so the specific `instanceof` checks stay
 * correct even if an `AbortError` wrapper ever does reach the catch (a future
 * p-retry change, or an `AbortError` thrown outside the retry callback).
 */
export function unwrapAbortError(error: unknown): unknown {
  return (error instanceof AbortError && error.originalError) || error;
}

/**
 * Whether an error is a request timeout.
 *
 * Covers three sources:
 * - ky's own `TimeoutError` (thrown when the `timeout:` option fires)
 * - `DOMException`/`Error` with `name === 'TimeoutError'` (thrown when
 *   `AbortSignal.timeout()` fires in Node.js 20+ / undici v6+)
 * - `AbortError` whose `cause` is a `TimeoutError` — the shape some undici
 *   versions produce when `AbortSignal.timeout()` fires mid-request
 */
export function isTimeoutError(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  if (error instanceof Error && error.name === 'TimeoutError') return true;
  if (
    error instanceof Error &&
    error.name === 'AbortError' &&
    isTimeoutError(error.cause)
  ) {
    return true;
  }
  return false;
}

/**
 * Whether an HTTP request error is transient (worth retrying).
 *
 * Transient = timeout, network-level failure (no response received), 429
 * rate limit, or 5xx server error.
 * Permanent = other 4xx responses and non-network errors.
 *
 * Only safe to use for idempotent requests (GET / read-only RPC); retrying
 * a non-idempotent write risks duplicate side effects.
 */
export function isTransientHttpError(error: unknown): boolean {
  if (isTimeoutError(error)) return true;
  if (error instanceof HTTPError) {
    return error.response.status === 429 || error.response.status >= 500;
  }
  // Network-level failure from the underlying fetch — connection reset, DNS
  // hiccup, socket hang-up. `fetch` surfaces these as a `TypeError`, but a bare
  // `instanceof TypeError` also swallows programmer errors (e.g. reading a
  // property of `undefined`) and silently retries them. `is-network-error`
  // matches only the known fetch/undici network-failure messages, so genuine
  // bugs in the wrapped call surface instead of being masked as transient.
  if (isNetworkError(error)) return true;
  return false;
}
