// OpenAI Responses wiring for the provider-neutral BackgroundRunLifecycle
// (support/BackgroundRunLifecycle.ts): the status vocabulary, retrieve call,
// error factories, and resume/poll classification policies the shared
// lifecycle plugs its control flow into. Constructed once per handler
// instance; see the handler's class doc for the single-turn rule.

import type { AgentTrace } from '@agent/trace';
import { detectStatusCode } from '@common/errors/sdkError/errorInspection';

import { BackgroundRunLifecycle } from '../support/BackgroundRunLifecycle';
import { tagOpenAISdkError } from './openAISdkError';
import {
  classifyOpenAIBackgroundResumeError,
  createOpenAIBackgroundPollingError,
  createOpenAIBackgroundPollingTimeoutError,
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
const BACKGROUND_MAX_DURATION_MS = 3 * 60 * 60 * 1000;
const BACKGROUND_POLL_INTERVAL_MS = 15000;

export function createOpenAIBackgroundRunLifecycle(deps: {
  /** Supplier rather than a snapshot: the handler's logger can be replaced
   *  after construction via `setLogger()`. */
  logger: () => AgentTrace;
  /** The provider tag applied to SDK errors (e.g. `'openai'`). */
  provider: string;
}): BackgroundRunLifecycle<
  OpenAI,
  Response,
  ResponseRetrieveParamsNonStreaming
> {
  const { logger, provider } = deps;
  return new BackgroundRunLifecycle({
    logger,
    providerLabel: 'OpenAI',
    resourceLabel: 'response',
    pollIntervalMs: BACKGROUND_POLL_INTERVAL_MS,
    maxDurationMs: BACKGROUND_MAX_DURATION_MS,
    isPendingStatus: (response) =>
      BACKGROUND_PENDING_STATUSES.includes(response.status as ResponseStatus),
    isServiceableStatus: (response) => response.status === 'completed',
    extractId: (response) => response.id,
    extractStatus: (response) => response.status ?? 'unknown',
    retrieve: (client, responseId, retrieveParams, signal) =>
      client.responses.retrieve(
        responseId,
        retrieveParams,
        signal ? { signal } : undefined,
      ),
    tagSdkError: (error) => tagOpenAISdkError(error, provider),
    onResumeRetrieveError: (error, responseId) => {
      // Transient failures (no status / 5xx / 429 / 408) — the background
      // response is likely still alive server-side, so retain the ID and
      // rethrow so the outer retry resumes the same ID. Definitive failures
      // (4xx, notably 404 expired) — clear the ID and create a new request.
      //
      // classifyOpenAIBackgroundResumeError checks statusCode directly rather
      // than providerError.userRetryable, so a definitive 404 always clears
      // the ID instead of being retained and looping until retries are
      // exhausted.
      const { providerError, shouldRetainPendingResponse } =
        classifyOpenAIBackgroundResumeError(error, provider);
      if (shouldRetainPendingResponse) return { action: 'retain' };
      logger().warn(
        "Couldn't resume the pending OpenAI response; will start a new request.",
        {
          data: {
            responseId,
            error: providerError.message,
            statusCode: providerError.statusCode,
          },
        },
      );
      return { action: 'restart' };
    },
    onPollRetrieveError: (error, responseId) => {
      // 404 "response not found" during polling means the response is truly
      // gone server-side. Clear the pending ID so the next retry creates a
      // fresh background request instead of routing through tryResume to
      // rediscover the 404.
      if (detectStatusCode(error) === 404) {
        return {
          action: 'replace',
          error: createOpenAIBackgroundPollingError(
            responseId,
            error,
            provider,
          ),
        };
      }
      // All other errors (401, 403, 5xx, network, etc.) propagate unchanged
      // so downstream handlers (retryability checks, non-retryable
      // classification) work correctly with full HTTP metadata.
      // The ID is intentionally NOT cleared — retry may resume the same response.
      return { action: 'retain' };
    },
    onRecoveredRetrieveError: (error) =>
      classifyOpenAIBackgroundResumeError(error, provider)
        .shouldRetainPendingResponse
        ? { action: 'retain' }
        : { action: 'clear' },
    createTimeoutError: (responseId) =>
      createOpenAIBackgroundPollingTimeoutError(
        responseId,
        BACKGROUND_MAX_DURATION_MS,
        provider,
      ),
    onResumeStart: (responseId) =>
      logger().debug(
        `Resuming polling for pending background response ${responseId}`,
      ),
    onResumeStillPending: (response, responseId) =>
      logger().debug(
        'Pending background response still processing, resuming poll',
        {
          data: { responseId, status: response.status },
        },
      ),
    onResumedSettled: (response, responseId) => {
      if (response.status === 'completed') {
        // Already completed while we were disconnected
        logger().debug(
          `Pending background response ${responseId} already completed`,
        );
        return { action: 'complete', response };
      }
      // Response failed remotely (failed/cancelled/incomplete)
      const errorDetail =
        response.error?.message ??
        response.incomplete_details?.reason ??
        'no additional details';
      logger().warn(
        'OpenAI background response ended remotely; starting a new request.',
        {
          data: {
            responseId,
            status: response.status,
            errorDetail,
            error: response.error ?? undefined,
            incompleteDetails: response.incomplete_details ?? undefined,
          },
        },
      );
      return { action: 'restart' };
    },
    clearOnServiceableTerminal: false,
    createTerminalVerdict: (polled, _responseId, stats) => {
      logger().error('Background response ended with a non-completed status', {
        data: {
          responseId: polled.id,
          status: polled.status,
          pollCount: stats?.pollCount,
          elapsedMs: stats?.elapsedMs,
          error: polled.error ?? undefined,
          incomplete: polled.incomplete_details ?? undefined,
        },
      });
      return {
        clearPending: true,
        error: createOpenAIBackgroundTerminalError(polled, provider),
      };
    },
    extraFinishData: (response) => ({ usage: response.usage ?? undefined }),
  });
}
