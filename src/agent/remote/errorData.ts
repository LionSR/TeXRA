/**
 * Convert ky's `HTTPError.data` (a parsed JSON value for JSON responses, or a
 * plain string otherwise) into a flat string for error messages, or `undefined`
 * when there is nothing useful to report.
 *
 * ky v2 populates `error.data` by consuming the response body, so the
 * `error.response` body methods (`.text()`, `.json()`) are not usable after a
 * request fails — read the error text from `error.data`, never the response.
 */
export function errorDataToString(data: unknown): string | undefined {
  if (typeof data === 'string') return data || undefined;
  if (data != null) return JSON.stringify(data);
  return undefined;
}

/**
 * Timeout for edge-function requests (30 s). Applied via `AbortSignal.timeout`
 * so it covers the whole request including the body read; ky's own `timeout`
 * clears once response headers arrive and would not guard `.json()`.
 */
export const FETCH_TIMEOUT_MS = 30_000;
