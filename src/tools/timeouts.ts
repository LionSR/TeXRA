/**
 * Shared request programs for tool implementations: one attempt under a
 * deadline ({@link withRequestTimeout}), the transient-failure retry every
 * network-boundary tool repeats ({@link retryTransientFetch}), and the
 * classification of a failed request into a `ToolError`
 * ({@link toFetchToolError}). Each tool defines its own timeout constant
 * locally; the failure policy is consistent here (built around the `ky`
 * HTTP client).
 *
 * A deadline is `Effect.timeoutOrElse`, the retry is an exponential
 * `Schedule` with the [1, 2) jitter window the tools were tuned to
 * ({@link transientBackoff}), and cancellation is fiber interruption:
 * `Effect.tryPromise` hands the attempt's own `AbortSignal` to the request,
 * so an interrupted run aborts the in-flight fetch instead of waiting out the
 * deadline or the next backoff. The caller's signal enters once, as the
 * `{ signal }` of the tool's run edge.
 */

import { Data, Duration, Effect, Random, Schedule } from 'effect';
import isNetworkError from 'is-network-error';
import { HTTPError, TimeoutError } from 'ky';

import { ToolError } from '@shared/schemas';
import { isTransientHttpStatus } from '@utils/core/httpStatus';
import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * Whether a request's own error is a timeout the client raised: ky's
 * `TimeoutError` (the `timeout:` option), a `DOMException`/`Error` named
 * `TimeoutError` (`AbortSignal.timeout()` in Node.js 20+ / undici v6+), or
 * an `AbortError` whose `cause` is one (the shape some undici versions
 * produce when `AbortSignal.timeout()` fires mid-request). This module's own
 * deadline is the {@link RequestTimedOut} tag, never one of these.
 */
function isTimeoutError(error: unknown): boolean {
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
  readonly message: string;
  readonly cause: unknown;
}> {}

/** A request attempt outlived its deadline. */
class RequestTimedOut extends Data.TaggedError('RequestTimedOut')<{
  readonly message: string;
  readonly timeoutMs: number;
}> {}

export type RequestError = RequestFailed | RequestTimedOut;

function isTransientRequestError(error: RequestError): boolean {
  return error._tag === 'RequestTimedOut' || isTransientHttpError(error.cause);
}

/**
 * One request under a deadline of `timeoutMs` that spans the whole of
 * `request` — connection and body read — where a client's own `timeout`
 * option (e.g. ky's) only clears once headers arrive. The signal handed to
 * `request` aborts when the attempt is interrupted, by the deadline or by
 * the caller. Fails with {@link RequestTimedOut} on the deadline and with
 * {@link RequestFailed} carrying the request's own error otherwise.
 *
 * `request` must declare its `signal` parameter and hand it to the client;
 * one that does not gets no signal at all and dies as a defect rather than
 * quietly outliving its own cancellation.
 */
export const withRequestTimeout = Effect.fn('timeouts.withRequestTimeout')(
  function* <T>(
    timeoutMs: number,
    request: (signal: AbortSignal) => Promise<T>,
  ) {
    // `Effect.tryPromise` creates the AbortSignal only when its callback
    // declares the parameter (`f.length !== 0`, effect's `tryPromise`). A
    // request written `() => ky.get(url)` therefore gets no signal, and
    // neither the deadline below nor the caller's interruption reaches the
    // in-flight request: it is abandoned to settle unobserved while this
    // program reports a timeout — a cancellation that silently does nothing.
    // TypeScript cannot catch it (a zero-parameter function is assignable to
    // a one-parameter type), so the misuse is a defect raised here.
    if (request.length === 0) {
      yield* Effect.die(
        new Error(
          'withRequestTimeout was given a request that declares no AbortSignal parameter, ' +
            'so neither the deadline nor the caller can abort it. Take the signal and hand ' +
            'it to the client: (signal) => ky.get(url, { signal }).',
        ),
      );
    }
    return yield* Effect.tryPromise({
      try: request,
      catch: (cause) =>
        new RequestFailed({ message: toErrorMessage(cause), cause }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () =>
          Effect.fail(
            new RequestTimedOut({
              message: `Request timed out after ${timeoutMs} ms`,
              timeoutMs,
            }),
          ),
      }),
    );
  },
);

interface RetryTransientFetchOptions {
  /** Retries after the first attempt. */
  readonly retries: number;
  /**
   * Base backoff before the first retry; doubles per retry, then scaled by
   * a uniform factor in [1, 2) — see {@link transientBackoff}.
   */
  readonly minTimeout: number;
  /** Deadline for each attempt, connection and body read included. */
  readonly timeoutMs: number;
  /**
   * Observes each transient failure — the attempts the schedule may retry,
   * the last exhausted one included. A permanent failure ends the retry
   * unobserved, since it never had retries left to report.
   */
  readonly onFailedAttempt?: (
    error: RequestError,
    retriesLeft: number,
  ) => Effect.Effect<void>;
}

/**
 * Backoff before retry `n` (1-based): `minTimeout * 2^(n-1)` scaled by a
 * uniform factor in [1, 2). This is the window the tools were tuned to under
 * p-retry's `randomize: true`; `Schedule.jittered` scales by [0.8, 1.2]
 * instead, which would cut the mean wait before a 429/5xx retry by a third.
 */
function transientBackoff(minTimeout: number) {
  return Schedule.exponential(Duration.millis(minTimeout)).pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.map(Random.next, (random) =>
        Duration.millis(Duration.toMillis(duration) * (1 + random)),
      ),
    ),
  );
}

/**
 * Run `fetchOnce` under a per-attempt deadline, retrying only transient
 * failures (timeout, network error, 429, 5xx) with exponential backoff and
 * full jitter — the pattern every network-boundary tool (web fetch/search,
 * Loogle) repeats. Any other failure — a non-transient HTTP status, a
 * response-shape or size-limit check `fetchOnce` throws itself — ends the
 * retry immediately and is the program's failure. Interruption stops both
 * the active attempt and the backoff sleep.
 */
export const retryTransientFetch = Effect.fn('timeouts.retryTransientFetch')(
  <T>(
    fetchOnce: (signal: AbortSignal) => Promise<T>,
    options: RetryTransientFetchOptions,
  ) =>
    withRequestTimeout(options.timeoutMs, fetchOnce).pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          if (!options.onFailedAttempt || !isTransientRequestError(error)) {
            return;
          }
          const { attempt } = yield* Schedule.CurrentMetadata;
          yield* options.onFailedAttempt(error, options.retries - attempt);
        }),
      ),
      Effect.retry({
        schedule: transientBackoff(options.minTimeout),
        times: options.retries,
        while: isTransientRequestError,
      }),
    ),
);

/** Tool-facing message for each failure class of a retried fetch. */
interface FetchToolErrorMessages {
  readonly timeout: string;
  readonly http: (status: number) => string;
  readonly network: (message: string) => string;
  readonly fallback: (message: string) => string;
}

/**
 * Classify the failure of a {@link retryTransientFetch} program into a
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
  error: RequestError,
  messages: FetchToolErrorMessages,
): ToolError {
  if (error._tag === 'RequestTimedOut' || isTimeoutError(error.cause)) {
    return new ToolError(messages.timeout);
  }
  if (error.cause instanceof HTTPError) {
    return new ToolError(messages.http(error.cause.response.status));
  }
  if (isNetworkError(error.cause)) {
    return new ToolError(messages.network(error.message));
  }
  return new ToolError(messages.fallback(error.message));
}
