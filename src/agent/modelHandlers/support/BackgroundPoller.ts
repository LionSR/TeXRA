// Local imports - utils
import { delay } from '@utils/core';

// Type imports
import type { AgentTrace } from '@agent/trace';

/**
 * Configuration for a {@link BackgroundPoller} instance.
 *
 * @typeParam TResponse - The provider-specific response type
 */
export interface BackgroundPollerConfig<TResponse> {
  /** Interval in milliseconds between consecutive poll retrievals. */
  readonly pollIntervalMs: number;
  /** Maximum total wall-clock duration for polling before giving up. */
  readonly maxDurationMs: number;
  /** Predicate: is the given response still being processed? */
  readonly isPending: (response: TResponse) => boolean;
  /** Logger for debug/progress output. */
  readonly logger: AgentTrace;
}

/**
 * Options for a single invocation of {@link BackgroundPoller.poll}.
 *
 * @typeParam TResponse - The provider-specific response type
 */
export interface BackgroundPollOptions<TResponse> {
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
   * Optional callback invoked on abort (best-effort). Handlers use this to
   * cancel the in-flight job server-side or clear local tracking state.
   */
  readonly onAbort?: (responseId: string) => void;
  /**
   * Human-readable label for log messages (e.g. `'OpenAI'`,
   * `'Google Interactions'`). Defaults to `'Background'`.
   */
  readonly providerLabel?: string;
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
      onAbort,
      providerLabel = 'Background',
    } = options;

    const responseId = extractId(initialResponse);
    if (!responseId) {
      return initialResponse;
    }

    const { pollIntervalMs, maxDurationMs, isPending, logger } = this.config;
    const startTime = Date.now();
    let current = initialResponse;
    let pollCount = 0;

    const initialStatus = extractStatus(current);
    logger.debug(
      `${providerLabel} polling started for response ${responseId} (status: ${initialStatus})`,
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
    signal?.addEventListener('abort', abortHandler, { once: true });
    if (signal?.aborted) abortHandler();

    try {
      while (isPending(current)) {
        pollCount += 1;
        logger.debug(
          `Waiting ${pollIntervalMs}ms before poll ${pollCount} for ${providerLabel} response ${responseId}`,
          {
            data: { responseId, pollCount, waitMs: pollIntervalMs },
          },
        );

        await delay(pollIntervalMs, { signal });

        const elapsedMs = Date.now() - startTime;
        if (elapsedMs > maxDurationMs) {
          logger.error(
            `${providerLabel} response ${responseId} exceeded maximum polling duration while pending`,
            {
              data: {
                responseId,
                status: extractStatus(current),
                pollCount,
                elapsedMs,
              },
            },
          );
          throw new Error(
            `${providerLabel} response ${responseId} exceeded maximum polling duration of ${maxDurationMs} ms.`,
          );
        }

        current = await retrieve(responseId, signal);

        logger.debug(
          `${providerLabel} poll ${pollCount} for response ${responseId}: status=${extractStatus(current)}`,
          {
            data: {
              responseId,
              status: extractStatus(current),
              pollCount,
            },
          },
        );
      }

      const elapsedMs = Date.now() - startTime;
      logger.debug(
        `${providerLabel} polling finished for response ${responseId} with status=${extractStatus(current)} after ${pollCount} polls (${elapsedMs} ms)`,
        {
          data: {
            responseId,
            status: extractStatus(current),
            pollCount,
            elapsedMs,
          },
        },
      );

      return current;
    } finally {
      signal?.removeEventListener('abort', abortHandler);
    }
  }
}
