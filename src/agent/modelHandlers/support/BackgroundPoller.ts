// Local imports - utils
import type { AgentTrace } from '@agent/trace';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { delay, onAbort as registerAbortHandler } from '@utils/core';

export interface BackgroundPollStats {
  readonly responseId: string;
  readonly status: string;
  readonly pollCount: number;
  readonly elapsedMs: number;
}

interface BackgroundPollTimeoutContext<TResponse> extends BackgroundPollStats {
  readonly maxDurationMs: number;
  readonly response: TResponse;
}

type BackgroundPollLogger = AgentTrace | (() => AgentTrace);

/**
 * Configuration for a {@link BackgroundPoller} instance.
 *
 * @typeParam TResponse - The provider-specific response type
 */
interface BackgroundPollerConfig<TResponse> {
  /** Interval in milliseconds between consecutive poll retrievals. */
  readonly pollIntervalMs: number;
  /** Maximum total wall-clock duration for polling before giving up. */
  readonly maxDurationMs: number;
  /** Predicate: is the given response still being processed? */
  readonly isPending: (response: TResponse) => boolean;
  /** Logger for debug/progress output, or a supplier for handlers with mutable loggers. */
  readonly logger: BackgroundPollLogger;
}

/**
 * Options for a single invocation of {@link BackgroundPoller.poll}.
 *
 * @typeParam TResponse - The provider-specific response type
 */
interface BackgroundPollOptions<TResponse> {
  /**
   * The response returned by the initial create/submit call. Its id is
   * extracted to key subsequent poll retrievals.
   */
  readonly initialResponse: TResponse;
  /** Retrieve the current state of the response by its id. */
  readonly retrieve: (
    responseId: string,
    signal?: AbortSignal,
  ) => Promise<TResponse>;
  /** Extract the id string from a response, or undefined if there is none. */
  readonly extractId: (response: TResponse) => string | undefined;
  /** Extract a human-readable status string for log messages. */
  readonly extractStatus: (response: TResponse) => string;
  /** Optional abort signal propagated to `delay` and `retrieve`. */
  readonly signal?: AbortSignal;
  /**
   * Absolute wall-clock deadline for a polling lifetime that began before
   * this invocation. When absent, this invocation receives the configured
   * maximum duration.
   */
  readonly deadlineAtMs?: number;
  /**
   * Optional callback invoked on abort (best-effort). Handlers use this to
   * cancel the in-flight job server-side or clear local tracking state.
   */
  readonly onAbort?: (responseId: string) => void;
  /** Resource noun for logs and timeout messages. Defaults to `response`. */
  readonly resourceLabel?: string;
  /**
   * Human-readable label for log messages (e.g. `'OpenAI'`,
   * `'Google Interactions'`). Defaults to `'Background'`.
   */
  readonly providerLabel?: string;
  /** Provider-specific timeout error or text with cancellation guidance. */
  readonly formatTimeoutError?: (
    context: BackgroundPollTimeoutContext<TResponse>,
  ) => Error | string;
  /**
   * Optional callback invoked (awaited) immediately before a deadline timeout
   * error is raised. Lets the caller run its own timeout side effects (e.g. a
   * server-side cancel or dropping pending-id bookkeeping) at the single site
   * where the timeout is raised, instead of matching the thrown error by
   * identity in a catch block (which silently skips the side effects if the
   * error is ever wrapped).
   */
  readonly onTimeout?: () => void | Promise<void>;
  /** Provider-specific fields to append to the final polling-finished log. */
  readonly extraFinishData?: (
    response: TResponse,
    stats: BackgroundPollStats,
  ) => Record<string, unknown>;
  /** Observe final poll stats without changing the returned response. */
  readonly onFinished?: (
    response: TResponse,
    stats: BackgroundPollStats,
  ) => void;
}

function resolveLogger(logger: BackgroundPollLogger): AgentTrace {
  return typeof logger === 'function' ? logger() : logger;
}

function safeExtraData<TResponse>(
  options: BackgroundPollOptions<TResponse>,
  response: TResponse,
  stats: BackgroundPollStats,
  logger: AgentTrace,
): Record<string, unknown> {
  try {
    return options.extraFinishData?.(response, stats) ?? {};
  } catch (err) {
    logger.warn(
      `BackgroundPoller: extraFinishData callback failed; omitting extra finish data: ${getSdkErrorMessage(err)}`,
      { data: err },
    );
    return {};
  }
}

/**
 * Shared polling collaborator for background / asynchronous API responses.
 *
 * Providers whose non-streaming endpoints return a pending response and expect
 * the client to periodically check for completion (OpenAI Responses API,
 * Google Interactions API) share the same mechanical polling loop:
 *
 * 1. While the response status is pending:
 *    a. Sleep for the configured poll interval (respecting the abort signal).
 *    b. Check if the max duration has been exceeded.
 *    c. Retrieve the current response state from the provider.
 *    d. Log the status.
 * 2. Return the final (terminal) response.
 *
 * Each handler composes this collaborator with its own create, retrieve,
 * error-classification, resume, and state-management logic.
 *
 * ## Usage
 *
 * ```typescript
 * const poller = new BackgroundPoller({
 *   pollIntervalMs: 15_000,
 *   maxDurationMs: 3 * 60 * 60 * 1000,
 *   isPending: (r) => ['queued', 'in_progress'].includes(r.status),
 *   logger: this.logger,
 * });
 *
 * const completed = await poller.poll({
 *   initialResponse: created,
 *   retrieve: (id, signal) => client.responses.retrieve(id, undefined, { signal }),
 *   extractId: (r) => r.id,
 *   extractStatus: (r) => r.status ?? 'unknown',
 *   signal,
 *   providerLabel: 'OpenAI',
 * });
 * ```
 */
export class BackgroundPoller<TResponse> {
  constructor(private readonly config: BackgroundPollerConfig<TResponse>) {}

  /**
   * Poll a pending response until it reaches a terminal status.
   *
   * Errors thrown by `retrieve` propagate unmodified — the caller is
   * responsible for classifying them (retryable vs. terminal) and for any
   * resume logic that chains a prior poll across retries.
   *
   * @returns The terminal response (no longer pending).
   */
  async poll(options: BackgroundPollOptions<TResponse>): Promise<TResponse> {
    const {
      initialResponse,
      retrieve,
      extractId,
      extractStatus,
      signal,
      deadlineAtMs,
      onAbort,
      resourceLabel = 'response',
      providerLabel = 'Background',
    } = options;

    const responseId = extractId(initialResponse);
    if (!responseId) {
      return initialResponse;
    }

    const { pollIntervalMs, maxDurationMs, isPending } = this.config;
    const logger = () => resolveLogger(this.config.logger);
    const startTime =
      deadlineAtMs === undefined ? Date.now() : deadlineAtMs - maxDurationMs;
    let current = initialResponse;
    let pollCount = 0;

    const throwIfTimedOut = async (response: TResponse): Promise<void> => {
      const now = Date.now();
      const elapsedMs = now - startTime;
      const timedOut =
        deadlineAtMs === undefined
          ? elapsedMs >= maxDurationMs
          : now >= deadlineAtMs;
      if (!timedOut) return;

      const stats = {
        responseId,
        status: extractStatus(response),
        pollCount,
        elapsedMs,
      };
      logger().error(
        `${providerLabel} ${resourceLabel} ${responseId} exceeded maximum polling duration while pending`,
        { data: { ...stats, maxDurationMs } },
      );
      const timeout =
        options.formatTimeoutError?.({
          ...stats,
          maxDurationMs,
          response,
        }) ??
        `${providerLabel} ${resourceLabel} ${responseId} exceeded maximum polling duration of ${maxDurationMs} ms.`;
      // Fire the caller's timeout side effects before the error propagates, so
      // they run even if a caller wraps the thrown error downstream.
      await options.onTimeout?.();
      throw timeout instanceof Error ? timeout : new Error(timeout);
    };

    const initialStatus = extractStatus(current);
    logger().debug(
      `${providerLabel} polling started for ${resourceLabel} ${responseId} (status: ${initialStatus})`,
      { data: { responseId, status: initialStatus } },
    );

    // Register a one-shot abort listener to fire the onAbort callback, then
    // let the signal propagate naturally through delay() and retrieve().
    const abortHandler = () => {
      if (onAbort) {
        try {
          onAbort(responseId);
        } catch {
          // Best-effort — swallow failures so the original abort propagates.
        }
      }
    };
    const detachAbortHandler = registerAbortHandler(signal, abortHandler);

    try {
      while (isPending(current)) {
        pollCount += 1;
        logger().debug(
          `Waiting ${pollIntervalMs}ms before poll ${pollCount} for ${providerLabel} ${resourceLabel} ${responseId}`,
          {
            data: { responseId, pollCount, waitMs: pollIntervalMs },
          },
        );

        try {
          await delay(pollIntervalMs, { signal });
        } catch (err) {
          if (isUserAbort(err)) {
            logger().debug(
              `${providerLabel} background polling aborted for ${resourceLabel} ${responseId} while waiting (poll ${pollCount}).`,
              {
                data: {
                  responseId,
                  pollCount,
                  elapsedMs: Date.now() - startTime,
                },
              },
            );
          }
          throw err;
        }

        if (deadlineAtMs !== undefined) signal?.throwIfAborted();
        await throwIfTimedOut(current);

        let retrieved: TResponse;
        try {
          retrieved = await retrieve(responseId, signal);
        } catch (err) {
          if (deadlineAtMs !== undefined && !isUserAbort(err)) {
            signal?.throwIfAborted();
            await throwIfTimedOut(current);
          }
          throw err;
        }
        if (deadlineAtMs !== undefined) {
          signal?.throwIfAborted();
          await throwIfTimedOut(retrieved);
        }
        current = retrieved;

        const polledStatus = extractStatus(current);
        logger().debug(
          `${providerLabel} poll ${pollCount} for ${resourceLabel} ${responseId}: status=${polledStatus}`,
          {
            data: {
              responseId,
              status: polledStatus,
              pollCount,
            },
          },
        );
      }

      const elapsedMs = Date.now() - startTime;
      const stats = {
        responseId,
        status: extractStatus(current),
        pollCount,
        elapsedMs,
      };
      logger().debug(
        `${providerLabel} polling finished for ${resourceLabel} ${responseId} with status=${stats.status} after ${pollCount} polls (${elapsedMs} ms)`,
        {
          data: {
            ...stats,
            ...safeExtraData(options, current, stats, logger()),
          },
        },
      );
      options.onFinished?.(current, stats);

      return current;
    } finally {
      detachAbortHandler();
    }
  }
}
