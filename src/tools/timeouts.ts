/**
 * Shared timeout and HTTP-error helpers for tool implementations.
 *
 * Each tool defines its own timeout constant locally. This module provides
 * the retry scaffolding and error-classification helpers that enforce a
 * consistent failure policy across tools (built around the `ky` HTTP client).
 *
 * The request programs run on Effect: a deadline is `Effect.timeoutOrElse`,
 * the transient-failure retry is a jittered exponential `Schedule`, and the
 * caller's cancellation `AbortSignal` becomes fiber interruption at the one
 * run boundary of each exported helper — `Effect.tryPromise` hands the
 * interrupted attempt's own signal to the underlying fetch, so an
 * interrupted run aborts the in-flight request instead of waiting out the
 * deadline or the next backoff.
 */

import { Cause, Data, Duration, Effect, Exit, Schedule } from 'effect';
import isNetworkError from 'is-network-error';
import { HTTPError, TimeoutError } from 'ky';

import { effectRuntime } from '@platform/processRuntime';
import { ToolError } from '@shared/schemas';
import { isTransientHttpStatus } from '@utils/core/httpStatus';
import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * Whether an error is a request timeout.
 *
 * Covers three sources:
 * - ky's own `TimeoutError` (thrown when the `timeout:` option fires)
 * - `DOMException`/`Error` with `name === 'TimeoutError'` (thrown when
 *   `AbortSignal.timeout()` fires in Node.js 20+ / undici v6+, and by this
 *   module's own deadline)
 * - `AbortError` whose `cause` is a `TimeoutError` — the shape some undici
 *   versions produce when `AbortSignal.timeout()` fires mid-request
 */
export function isTimeoutError(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError') return true;
  return error.name === 'AbortError' && isTimeoutError(error.cause);
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

/** A request attempt rejected; `cause` is the request's own error. */
class RequestFailed extends Data.TaggedError('RequestFailed')<{
  readonly cause: unknown;
}> {}

/** A request attempt outlived its deadline. */
class RequestTimedOut extends Data.TaggedError('RequestTimedOut')<{
  readonly timeoutMs: number;
}> {}

type RequestError = RequestFailed | RequestTimedOut;

/**
 * The error a request program throws at its Promise edge: the request's own
 * rejection unchanged, or — for the deadline — the same `TimeoutError`
 * DOMException `AbortSignal.timeout()` produces, so {@link isTimeoutError}
 * classifies it wherever the caller matches on it.
 */
function toThrowable(error: RequestError): unknown {
  return error._tag === 'RequestTimedOut'
    ? new DOMException(
        `Request timed out after ${error.timeoutMs} ms`,
        'TimeoutError',
      )
    : error.cause;
}

function isTransientRequestError(error: RequestError): boolean {
  return error._tag === 'RequestTimedOut' || isTransientHttpError(error.cause);
}

/**
 * One request attempt under a deadline that spans the whole of `request` —
 * connection and body read — where a client's own `timeout` option (e.g.
 * ky's) only clears once headers arrive. The signal handed to `request`
 * aborts when the attempt is interrupted, by the deadline or by the caller.
 */
const requestAttempt = Effect.fn('timeouts.requestAttempt')(
  <T>(timeoutMs: number, request: (signal: AbortSignal) => Promise<T>) =>
    Effect.tryPromise({
      try: request,
      catch: (cause) => new RequestFailed({ cause }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () => Effect.fail(new RequestTimedOut({ timeoutMs })),
      }),
    ),
);

/**
 * Settle a request program at its Promise edge. An interruption delivered by
 * the caller's cancellation signal rethrows that signal's reason — what the
 * aborted fetch itself would have thrown.
 */
function settleRequest<T>(
  exit: Exit.Exit<T, RequestError>,
  cancelSignal: AbortSignal | undefined,
): T {
  if (Exit.isSuccess(exit)) return exit.value;
  if (cancelSignal?.aborted && Cause.hasInterruptsOnly(exit.cause)) {
    throw cancelSignal.reason;
  }
  const failure = Cause.squash(exit.cause);
  throw failure instanceof RequestFailed || failure instanceof RequestTimedOut
    ? toThrowable(failure)
    : failure;
}

/**
 * Run one request under a deadline of `timeoutMs`, interrupted early when
 * the run's cancellation signal fires. Rejects with a `TimeoutError`
 * DOMException on the deadline ({@link isTimeoutError} classifies it), with
 * the request's own error otherwise, and with the signal's abort reason on
 * cancellation.
 */
export async function withRequestTimeout<T>(
  timeoutMs: number,
  cancelSignal: AbortSignal | undefined,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  cancelSignal?.throwIfAborted();
  const exit = await effectRuntime().runPromiseExit(
    requestAttempt(timeoutMs, request),
    { signal: cancelSignal },
  );
  return settleRequest(exit, cancelSignal);
}

interface RetryTransientFetchOptions {
  /** Retries after the first attempt. */
  readonly retries: number;
  /** Base backoff before the first retry; doubles per retry, jittered. */
  readonly minTimeout: number;
  /** Deadline for each attempt, connection and body read included. */
  readonly timeoutMs: number;
  readonly cancelSignal?: AbortSignal;
  /** Observes every failed attempt with the error the edge would throw. */
  readonly onFailedAttempt?: (error: unknown, retriesLeft: number) => void;
}

const retryingRequest = Effect.fn('timeouts.retryTransientFetch')(
  <T>(
    fetchOnce: (signal: AbortSignal) => Promise<T>,
    options: RetryTransientFetchOptions,
  ) =>
    requestAttempt(options.timeoutMs, fetchOnce).pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          const { attempt } = yield* Schedule.CurrentMetadata;
          options.onFailedAttempt?.(
            toThrowable(error),
            options.retries - attempt,
          );
        }),
      ),
      Effect.retry({
        schedule: Schedule.exponential(
          Duration.millis(options.minTimeout),
        ).pipe(Schedule.jittered),
        times: options.retries,
        while: isTransientRequestError,
      }),
    ),
);

/**
 * Run `fetchOnce` under a per-attempt deadline, retrying only transient
 * failures (timeout, network error, 429, 5xx) with jittered exponential
 * backoff — the pattern every network-boundary tool (web fetch/search,
 * Loogle) repeats. Any other rejection — a non-transient HTTP status, a
 * response-shape or size-limit check `fetchOnce` throws itself — ends the
 * retry immediately and is rethrown unchanged. Cancellation stops both the
 * active attempt and the backoff sleep.
 */
export async function retryTransientFetch<T>(
  fetchOnce: (signal: AbortSignal) => Promise<T>,
  options: RetryTransientFetchOptions,
): Promise<T> {
  options.cancelSignal?.throwIfAborted();
  const exit = await effectRuntime().runPromiseExit(
    retryingRequest(fetchOnce, options),
    { signal: options.cancelSignal },
  );
  return settleRequest(exit, options.cancelSignal);
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
 * user-facing label share one predicate, an error cannot be retried as
 * transient and then mislabeled as a network failure, or vice versa.
 */
export function toFetchToolError(
  error: unknown,
  messages: FetchToolErrorMessages,
): ToolError {
  if (isTimeoutError(error)) {
    return new ToolError(messages.timeout);
  }
  if (error instanceof HTTPError) {
    return new ToolError(messages.http(error.response.status));
  }
  if (isNetworkError(error)) {
    return new ToolError(messages.network(toErrorMessage(error)));
  }
  return new ToolError(messages.fallback(toErrorMessage(error)));
}
