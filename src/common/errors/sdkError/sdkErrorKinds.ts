import { StatusCodes } from 'http-status-codes';

/**
 * Server errors (5xx), conflicts (409), rate limits (429), and request
 * timeouts (408) are retryable — these are transient. Other client errors
 * (4xx) are deterministic.
 *
 * This is the provider-SDK error policy, not the general HTTP one. It
 * deliberately diverges from `isTransientHttpStatus`
 * (`utils/core/httpStatus.ts`) by including 409: a provider API's conflict
 * usually reflects a transient session/resource race, so it stays
 * user-retryable here even though a generic HTTP 409 is not. See that
 * function's doc comment for the reverse pointer.
 */
export function isRetryableStatusCode(statusCode?: number): boolean {
  if (statusCode === undefined) return false;
  if (statusCode >= 500) return true;
  return (
    statusCode === StatusCodes.CONFLICT ||
    statusCode === StatusCodes.TOO_MANY_REQUESTS ||
    statusCode === StatusCodes.REQUEST_TIMEOUT
  );
}

export function pickStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}
