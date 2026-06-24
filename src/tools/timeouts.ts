/**
 * Shared timeout and HTTP-error helpers for tool implementations.
 *
 * Each tool defines its own timeout constant locally. This module only
 * provides the predicates that enforce a consistent error-classification
 * policy across tools (built around the `ky` HTTP client).
 */

import { HTTPError, TimeoutError } from 'ky';

/**
 * Whether an error is a request timeout.
 *
 * Covers two sources:
 * - ky's own `TimeoutError` (thrown when the `timeout:` option fires)
 * - `DOMException`/`Error` with `name === 'TimeoutError'` (thrown when
 *   `AbortSignal.timeout()` fires before the response or body arrives)
 */
export function isTimeoutError(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  if (error instanceof Error && error.name === 'TimeoutError') return true;
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
  // Network-level TypeError from the underlying fetch — connection reset, DNS
  // hiccup, socket hang-up. TypeErrors from ky/fetch calls are always network
  // failures; programmer TypeErrors don't surface here.
  if (error instanceof TypeError) return true;
  return false;
}
