/**
 * Shared request programs for tool implementations: one attempt under a
 * deadline ({@link withRequestTimeout}), the transient-failure retry every
 * network-boundary tool repeats ({@link retryTransientFetch}), and the
 * classification of a failed request into a `ToolError`
 * ({@link toFetchToolError}). Each tool defines its own timeout constant
 * locally; the failure policy is consistent here. Requests go through the
 * process `HttpClient`, so a request fails with its `HttpClientError` (a
 * `TransportError` when nothing answered, a `StatusCodeError` for a rejected
 * status) or, at the deadline, with `Cause.TimeoutError`.
 *
 * A deadline is `Effect.timeout`, the retry is the shared
 * {@link randomizedExponentialBackoff} `Schedule` — the [1, 2) jitter window
 * the tools were tuned to under p-retry's `randomize: true`, and deliberately
 * not `Schedule.jittered`, whose [0.8, 1.2] would cut the mean wait before a
 * 429/5xx retry by a third — and cancellation is fiber interruption. Each
 * attempt owns a scope for the entire request, including the response
 * body: the request takes its client from {@link scopedOkClient} so the
 * scope's end aborts it.
 */

import { Cause, Duration, Effect, Schedule, Scope } from 'effect';
import { HttpClient, HttpClientError } from 'effect/unstable/http';

import { ToolError } from '@shared/schemas';
import { randomizedExponentialBackoff } from '@utils/core/backoffSchedule';
import { isTransientHttpStatus } from '@utils/core/httpStatus';
import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * A request that got no (complete) answer: nothing responded, or the
 * connection dropped mid-body (undici's `TypeError`, "terminated"; a
 * malformed body is a `SyntaxError`).
 */
export function isTransportReason(
  reason: HttpClientError.HttpClientError['reason'],
): boolean {
  return (
    reason._tag === 'TransportError' ||
    (reason._tag === 'DecodeError' && reason.cause instanceof TypeError)
  );
}

/**
 * Whether a request's failure is transient (worth retrying): the deadline, a
 * transport failure (no response received), or a 408/429/5xx status. Every
 * other failure is permanent: other 4xx statuses, a body that did not decode,
 * and whatever the request itself reports (a size limit, a response shape).
 *
 * Only safe to use for idempotent requests (GET / read-only RPC); retrying
 * a non-idempotent write risks duplicate side effects.
 */
function isTransientRequestError(error: Error): boolean {
  if (Cause.isTimeoutError(error)) return true;
  if (!HttpClientError.isHttpClientError(error)) return false;
  const { reason } = error;
  return (
    isTransportReason(reason) ||
    (reason._tag === 'StatusCodeError' &&
      isTransientHttpStatus(reason.response.status))
  );
}

/**
 * The process client for one attempt under {@link withRequestTimeout}: the
 * attempt's scope aborts its requests. Every tool request takes its client
 * from here or {@link scopedOkClient}.
 */
export const scopedClient = Effect.map(
  HttpClient.HttpClient,
  HttpClient.withScope,
);

/** {@link scopedClient} where a non-2xx status fails with a `StatusCodeError`. */
export const scopedOkClient = Effect.map(
  scopedClient,
  HttpClient.filterStatusOk,
);

/**
 * One request under a deadline of `timeoutMs` that spans the whole of
 * `request` — connection and body read. The attempt's scope stays open
 * through the body read, so the request (see {@link scopedOkClient}) aborts
 * when the whole attempt ends. Fails with `Cause.TimeoutError` on the deadline
 * and otherwise with the request's own failure. Defects and interruption are
 * not converted into request failures.
 */
export const withRequestTimeout = Effect.fn('timeouts.withRequestTimeout')(
  <T, E, R>(timeoutMs: number, request: Effect.Effect<T, E, R | Scope.Scope>) =>
    Effect.scoped(request).pipe(Effect.timeout(Duration.millis(timeoutMs))),
);

interface RetryTransientFetchOptions<E> {
  /** Retries after the first attempt. */
  readonly retries: number;
  /**
   * Base backoff before the first retry; doubles per retry, then scaled by
   * a uniform factor in [1, 2) — see {@link randomizedExponentialBackoff}.
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
    error: E | Cause.TimeoutError,
    retriesLeft: number,
  ) => Effect.Effect<void>;
}

/**
 * Run `request` under a per-attempt deadline, retrying only transient
 * failures (timeout, transport failure, 408/429, 5xx) with exponential
 * backoff and full jitter — the pattern every network-boundary tool (web
 * fetch/search, Loogle) repeats. Any other failure — a non-transient HTTP
 * status, a response-shape or size-limit failure reported by `request` — ends
 * the retry immediately and is the program's failure. Interruption stops both
 * the active attempt and the backoff sleep.
 */
export const retryTransientFetch = Effect.fn('timeouts.retryTransientFetch')(
  <T, E extends Error, R>(
    request: Effect.Effect<T, E, R | Scope.Scope>,
    options: RetryTransientFetchOptions<E>,
  ) =>
    withRequestTimeout(options.timeoutMs, request).pipe(
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
        schedule: randomizedExponentialBackoff(
          Duration.millis(options.minTimeout),
        ),
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
 * The retry decision reads the same `HttpClientError` reasons, so an error
 * cannot be retried as transient and then mislabeled, or vice versa.
 */
export function toFetchToolError(
  error: Error,
  messages: FetchToolErrorMessages,
): ToolError {
  if (Cause.isTimeoutError(error)) return new ToolError(messages.timeout);
  if (HttpClientError.isHttpClientError(error)) {
    const { reason } = error;
    if (reason._tag === 'StatusCodeError') {
      return new ToolError(messages.http(reason.response.status));
    }
    if (isTransportReason(reason)) {
      return new ToolError(
        messages.network(toErrorMessage(reason.cause ?? error)),
      );
    }
  }
  return new ToolError(messages.fallback(error.message));
}
