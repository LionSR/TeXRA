// Background-run lifecycle for the OpenAI Responses API.
//
// Owns the pending-background-response bookkeeping (the id + retrieve params
// needed to resume polling after a disconnect) and the choreography around
// the shared BackgroundPoller: resuming a response left pending by a prior
// connection failure, polling a freshly-submitted response to completion, and
// recovering a response id surfaced by an unhandled mid-stream SSE event. The
// handler asks this collaborator "is anything pending, and what do I do about
// it" instead of mutating pending-response fields itself — every field here
// is private, reachable only through the narrow methods below.
//
// Like the handler it's attached to, an instance is single-turn: do not share
// it across concurrent invocations (see the handler's class doc).

import type { AgentTrace } from '@agent/trace';
import { detectStatusCode, isUserAbort } from '@common/errors/sdkErrorUtils';

import {
  BackgroundPoller,
  type BackgroundPollStats,
} from '../support/BackgroundPoller';
import { tagOpenAISdkError } from './openAISdkError';
import {
  classifyOpenAIBackgroundResumeError,
  createOpenAIBackgroundPollingError,
  createOpenAIBackgroundTerminalError,
} from './openAIResponseErrors';
import type OpenAI from 'openai';
import type {
  Response,
  ResponseRetrieveParamsNonStreaming,
  ResponseStatus,
} from 'openai/resources/responses/responses';

/** Statuses indicating a response is still processing. */
const BACKGROUND_PENDING_STATUSES: readonly ResponseStatus[] = [
  'queued',
  'in_progress',
];

/** Collaborators the lifecycle borrows from the owning handler. */
interface BackgroundRunLifecycleDeps {
  /** Supplier rather than a snapshot: the handler's logger can be replaced
   *  after construction via `setLogger()`. */
  logger: () => AgentTrace;
  /** The provider tag applied to SDK errors (e.g. `'openai'`). */
  provider: string;
}

export class BackgroundRunLifecycle {
  private readonly backgroundPoller = new BackgroundPoller<Response>({
    pollIntervalMs: 15000,
    maxDurationMs: 3 * 60 * 60 * 1000, // 3 hours
    isPending: (r) => this.isPending(r),
    logger: this.deps.logger,
  });

  /**
   * The id of a background response currently being polled. Lets retry logic
   * resume polling the same response instead of creating a new request when
   * connection errors occur mid-poll.
   */
  private pendingResponseId: string | null = null;
  private pendingRetrieveParams: ResponseRetrieveParamsNonStreaming | undefined;

  constructor(private readonly deps: BackgroundRunLifecycleDeps) {}

  private get logger(): AgentTrace {
    return this.deps.logger();
  }

  /** Whether the given response's status still means "processing". */
  isPending(response: Response): boolean {
    return BACKGROUND_PENDING_STATUSES.includes(
      response.status as ResponseStatus,
    );
  }

  /** Whether a background response is currently pending resume. */
  hasPendingResume(): boolean {
    return this.pendingResponseId !== null;
  }

  /** The id of the pending background response, if any (diagnostics only). */
  getPendingId(): string | null {
    return this.pendingResponseId;
  }

  /** Clears the pending background response id. Single point of mutation. */
  clearPending(): void {
    this.pendingResponseId = null;
    this.pendingRetrieveParams = undefined;
  }

  private rememberPending(
    responseId: string,
    retrieveParams?: ResponseRetrieveParamsNonStreaming,
  ): void {
    this.pendingResponseId = responseId;
    this.pendingRetrieveParams = retrieveParams;
  }

  /**
   * Attempts to resume polling a pending background response.
   *
   * @returns The completed response if resume succeeded, or null if a new
   *          request is needed. Throws on abort (user cancellation).
   */
  async tryResume(
    client: OpenAI,
    signal?: AbortSignal,
  ): Promise<Response | null> {
    const pendingId = this.pendingResponseId;
    if (!pendingId) {
      return null;
    }
    const retrieveParams = this.pendingRetrieveParams;

    this.logger.debug(
      `Resuming polling for pending background response ${pendingId}`,
    );

    let pendingResponse: Response;
    try {
      pendingResponse = await client.responses.retrieve(
        pendingId,
        retrieveParams,
        signal ? { signal } : undefined,
      );
    } catch (err) {
      // Tag before checking: the SDK throws APIUserAbortError (not a
      // DOMException) when the signal fires inside retrieve(), and the tag
      // makes isUserAbort() robust even in minified bundles.
      tagOpenAISdkError(err, this.deps.provider);
      if (isUserAbort(err)) {
        this.clearPending();
        throw err;
      }
      // Transient failures (no status / 5xx / 429 / 408) — the background
      // response is likely still alive server-side, so retain the ID and
      // rethrow so the outer retry resumes the same ID. Definitive failures
      // (4xx, notably 404 expired) — clear the ID and create a new request.
      //
      // Check statusCode directly rather than providerError.userRetryable: the latter
      // is force-true for relay errors, which would incorrectly retain the ID
      // on a relay-wrapped 404 and loop until retries are exhausted.
      const { providerError, shouldRetainPendingResponse } =
        classifyOpenAIBackgroundResumeError(err, this.deps.provider);
      if (shouldRetainPendingResponse) {
        throw err;
      }
      this.logger.warn(
        "Couldn't resume the pending OpenAI response; will start a new request.",
        {
          data: {
            responseId: pendingId,
            error: providerError.message,
            statusCode: providerError.statusCode,
          },
        },
      );
      this.clearPending();
      return null;
    }

    // Check the status of the retrieved response
    if (this.isPending(pendingResponse)) {
      // Still processing - resume polling
      this.logger.debug(
        'Pending background response still processing, resuming poll',
        {
          data: { responseId: pendingId, status: pendingResponse.status },
        },
      );
      const response = await this.waitForCompletion(
        client,
        pendingResponse,
        signal,
        retrieveParams,
      );
      // Note: clearPending() called by the handler's finalizeResponse() in caller
      return response;
    }

    if (pendingResponse.status === 'completed') {
      // Already completed while we were disconnected
      this.logger.debug(
        `Pending background response ${pendingId} already completed`,
      );
      // Note: clearPending() called by the handler's finalizeResponse() in caller
      return pendingResponse;
    }

    // Response failed remotely (failed/cancelled/incomplete)
    const errorDetail =
      pendingResponse.error?.message ??
      pendingResponse.incomplete_details?.reason ??
      'no additional details';
    this.logger.warn(
      'OpenAI background response ended remotely; starting a new request.',
      {
        data: {
          responseId: pendingId,
          status: pendingResponse.status,
          errorDetail,
          error: pendingResponse.error ?? undefined,
          incompleteDetails: pendingResponse.incomplete_details ?? undefined,
        },
      },
    );
    this.clearPending();
    return null;
  }

  /**
   * Retrieves a response by id after an unhandled mid-stream SSE event (a
   * heartbeat/keepalive frame the SDK's stream accumulator doesn't parse),
   * remembering it as pending so a connection failure during the retrieve can
   * be resumed via {@link tryResume} instead of starting a new request.
   * Unlike {@link tryResume}, failures here always rethrow to the caller's own
   * streaming catch block, which owns retry classification for that path.
   */
  async retrieveAndRemember(
    client: OpenAI,
    responseId: string,
    retrieveParams: ResponseRetrieveParamsNonStreaming | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    this.rememberPending(responseId, retrieveParams);
    try {
      return await client.responses.retrieve(
        responseId,
        retrieveParams,
        signal ? { signal } : undefined,
      );
    } catch (err) {
      tagOpenAISdkError(err, this.deps.provider);
      if (isUserAbort(err)) {
        this.clearPending();
        throw err;
      }
      const { shouldRetainPendingResponse } =
        classifyOpenAIBackgroundResumeError(err, this.deps.provider);
      if (!shouldRetainPendingResponse) {
        this.clearPending();
      }
      throw err;
    }
  }

  /**
   * Poll a (possibly just-submitted) response until it reaches a terminal
   * status, remembering the id as pending so a connection failure mid-poll
   * can be resumed via {@link tryResume} instead of starting a new request.
   */
  async waitForCompletion<T extends Response>(
    client: OpenAI,
    initialResponse: T,
    signal?: AbortSignal,
    retrieveParams?: ResponseRetrieveParamsNonStreaming,
  ): Promise<T> {
    if (!initialResponse.id) {
      return initialResponse;
    }

    // Track which response is being polled so retry logic can resume via
    // tryResume instead of creating a new request.
    this.rememberPending(initialResponse.id, retrieveParams);

    let pollStats: BackgroundPollStats | undefined;
    const polled = (await this.backgroundPoller.poll({
      initialResponse,
      retrieve: async (responseId, sig) => {
        try {
          return (await client.responses.retrieve(
            responseId,
            retrieveParams,
            sig ? { signal: sig } : undefined,
          )) as T;
        } catch (err) {
          // Tag before checking: retrieve() throws the SDK's APIUserAbortError,
          // not a DOMException, when the signal fires.
          tagOpenAISdkError(err, this.deps.provider);
          if (isUserAbort(err)) {
            // User cancelled during retrieve — clear pending ID to prevent
            // ghost-resume on next call.
            this.clearPending();
            throw err;
          }
          // 404 "response not found" during polling means the response is truly
          // gone server-side. Clear the pending ID so the next retry creates a
          // fresh background request instead of routing through tryResume to
          // rediscover the 404.
          const statusCode = detectStatusCode(err);
          if (statusCode === 404) {
            this.clearPending();
            throw createOpenAIBackgroundPollingError(
              responseId,
              err,
              this.deps.provider,
            );
          }
          // All other errors (401, 403, 5xx, network, etc.) propagate unchanged
          // so downstream handlers (relay 401 token refresh, retryability checks,
          // non-retryable classification) work correctly with full HTTP metadata.
          // The ID is intentionally NOT cleared — retry may resume the same response.
          throw err;
        }
      },
      extractId: (r) => r.id,
      extractStatus: (r) => r.status ?? 'unknown',
      signal,
      resourceLabel: 'response',
      providerLabel: 'OpenAI',
      onAbort: () => this.clearPending(),
      formatTimeoutError: ({ responseId, maxDurationMs }) =>
        `OpenAI response ${responseId} exceeded maximum polling duration of ${maxDurationMs} ms. ` +
        `Retry later or cancel the job with client.responses.cancel("${responseId}").`,
      extraFinishData: (response) => ({
        usage: response.usage ?? undefined,
      }),
      onFinished: (_response, stats) => {
        pollStats = stats;
      },
    })) as T;

    if (polled.status === 'completed') {
      return polled;
    }

    // Terminal failure — the background response ended with a non-completed,
    // non-pending status (failed / cancelled / incomplete).
    this.logger.error('Background response ended with a non-completed status', {
      data: {
        responseId: polled.id,
        status: polled.status,
        pollCount: pollStats?.pollCount,
        elapsedMs: pollStats?.elapsedMs,
        error: polled.error ?? undefined,
        incomplete: polled.incomplete_details ?? undefined,
      },
    });
    throw createOpenAIBackgroundTerminalError(polled, this.deps.provider);
  }
}
