/**
 * Shared timeout and HTTP-error helpers for tool implementations.
 *
 * Each tool defines its own timeout constant locally. This module provides
 * the retry scaffolding and error-classification helpers that enforce a
 * consistent failure policy across tools (built around the `ky` HTTP client).
 */

import isNetworkError from 'is-network-error';
import { HTTPError, TimeoutError } from 'ky';
import pRetry, { AbortError, type Options as PRetryOptions } from 'p-retry';

import { ToolError } from '@shared/schemas';
import { isTransientHttpStatus } from '@utils/core/httpStatus';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

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
 * Transient = timeout, network-level failure (no response received), 408
 * request timeout, 429 rate limit, or 5xx server error.
 * Permanent = other 4xx responses and non-network errors.
 *
 * Only safe to use for idempotent requests (GET / read-only RPC); retrying
 * a non-idempotent write risks duplicate side effects.
 */
export function isTransientHttpError(error: unknown): boolean {
  if (isTimeoutError(error)) return true;
  if (error instanceof HTTPError) {
    return isTransientHttpStatus(error.response.status);
  }
  // Network-level failure from the underlying fetch — connection reset, DNS
  // hiccup, socket hang-up. `fetch` surfaces these as a `TypeError`, but a bare
  // `instanceof TypeError` also swallows programmer errors (e.g. reading a
  // property of `undefined`) and silently retries them. `is-network-error`
  // matches only the known fetch/undici network-failure messages, so genuine
  // bugs in the wrapped call surface instead of being masked as transient.
  return isNetworkError(error);
}

/**
 * Join a per-call timeout with the run's cancellation signal (if any).
 *
 * `AbortSignal.timeout` covers both connection and body read; a client's own
 * `timeout` option (e.g. ky's) only clears once headers arrive. The run's
 * cancellation signal joins in so an interrupted run aborts in-flight
 * requests instead of waiting out the timeout.
 */
export function joinAbortSignal(
  timeoutMs: number,
  cancelSignal?: AbortSignal,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return cancelSignal
    ? AbortSignal.any([cancelSignal, timeoutSignal])
    : timeoutSignal;
}

/**
 * Run `fetchOnce` under p-retry, retrying only transient failures (timeout,
 * network error, 429, 5xx) with jittered backoff — the pattern every
 * network-boundary tool (web fetch/search, Loogle) repeats: classify the
 * error, retry if transient, otherwise abort immediately. Zotero's
 * `bbtClient.ts` shares only this module's abort-signal join, not the retry
 * classification — it has no retry loop of its own.
 *
 * `fetchOnce` may itself throw an {@link AbortError} (e.g. a response-shape
 * or size-limit check) to abort retries without going through the
 * transient-error classification; that error passes through unwrapped.
 */
export async function retryTransientFetch<T>(
  fetchOnce: () => Promise<T>,
  options: {
    retries: number;
    minTimeout: number;
    cancelSignal?: AbortSignal;
    onFailedAttempt?: PRetryOptions['onFailedAttempt'];
  },
): Promise<T> {
  return pRetry(
    async () => {
      try {
        return await fetchOnce();
      } catch (error: unknown) {
        if (error instanceof AbortError || isTransientHttpError(error)) {
          throw error;
        }
        throw new AbortError(ensureError(error));
      }
    },
    {
      retries: options.retries,
      minTimeout: options.minTimeout,
      randomize: true,
      // Stop retrying (and skip inter-retry delays) once the run is cancelled.
      signal: options.cancelSignal,
      onFailedAttempt: options.onFailedAttempt,
    },
  );
}

/** Tool-facing message for each failure class of a retried fetch. */
interface FetchToolErrorMessages {
  readonly timeout: string;
  readonly http: (status: number) => string;
  readonly network: (message: string) => string;
  readonly fallback: (message: string) => string;
}

/**
 * Classify the error from a failed {@link retryTransientFetch} call into a
 * {@link ToolError}: timeout, HTTP status, network failure, or fallback.
 *
 * The network predicate here is the same one `isTransientHttpError` uses for
 * the retry decision — `isNetworkError`, not a bare `instanceof TypeError`.
 * A bare TypeError check would label a genuine bug in the fetch/response path
 * (e.g. reading a property of `undefined`) as a network failure, contradicting
 * this module's own guidance; `is-network-error` matches only the known
 * fetch/undici network-failure shapes. Because the retry loop and the final
 * user-facing label now share one predicate, an error cannot be retried as
 * transient and then mislabeled as a network failure, or vice versa.
 */
export function toFetchToolError(
  error: unknown,
  messages: FetchToolErrorMessages,
): ToolError {
  // Defensive: ensure the specific type checks below see the real error
  // even if a p-retry AbortError wrapper reaches here (p-retry v8 already
  // unwraps it to .originalError, so this is normally a no-op).
  const err = unwrapAbortError(error);
  if (isTimeoutError(err)) {
    return new ToolError(messages.timeout);
  }
  if (err instanceof HTTPError) {
    return new ToolError(messages.http(err.response.status));
  }
  if (isNetworkError(err)) {
    return new ToolError(messages.network(toErrorMessage(err)));
  }
  return new ToolError(messages.fallback(toErrorMessage(err)));
}
