/**
 * Shared timeout helpers for tool implementations.
 *
 * Each tool defines its own timeout constant locally. This module only
 * provides the helpers that enforce a consistent error format across tools.
 */

import axios from 'axios';

/**
 * Check whether an axios error code indicates a timeout.
 *
 * axios uses ECONNABORTED by default and ETIMEDOUT when
 * `clarifyTimeoutError` is enabled or via the fetch adapter.
 */
export function isTimeoutErrorCode(code: string | undefined): boolean {
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT';
}

/**
 * Whether an error from an axios request is worth retrying.
 *
 * Transient = a retry could plausibly succeed: request timeouts, network-level
 * failures (no response received — DNS hiccup, connection reset), and 5xx
 * server errors. Permanent = the same request will keep failing: any 4xx
 * status (bad request, not found, auth), and non-axios/application errors.
 *
 * Only safe to use for idempotent requests (GET / read-only RPC); retrying a
 * non-idempotent write risks duplicate side effects.
 */
export function isTransientHttpError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (isTimeoutErrorCode(error.code)) return true;
  // No response means the request never completed (connection reset, DNS,
  // socket hang up) — generally worth one more attempt for an external API.
  if (!error.response) return true;
  return error.response.status >= 500;
}
