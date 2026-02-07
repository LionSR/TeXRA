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

/**
 * Build a consistent timeout error message.
 *
 * @example buildTimeoutMessage('Command execution', 120_000)
 * // → "Command execution timed out after 120s."
 */
export function buildTimeoutMessage(action: string, timeoutMs: number): string {
  return `${action} timed out after ${timeoutMs / 1000}s.`;
}
