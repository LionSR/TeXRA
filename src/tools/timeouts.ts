/**
 * Shared timeout helpers for tool implementations.
 *
 * Each tool defines its own timeout constant locally. This module only
 * provides the helpers that enforce a consistent error format across tools.
 */

/**
 * Check whether an axios error code indicates a timeout.
 *
 * axios uses ECONNABORTED by default and ETIMEDOUT when
 * `clarifyTimeoutError` is enabled or via the fetch adapter.
 */
export function isTimeoutErrorCode(code: string | undefined): boolean {
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT';
}
