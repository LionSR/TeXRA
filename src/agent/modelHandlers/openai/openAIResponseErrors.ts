// Local imports - common errors
import {
  attachFlowAutoRetryRequired,
  isRetryableStatusCode,
  normalizeProviderError,
} from '@common/errors/sdkErrorUtils';

// Type imports
import type { ProviderError } from '@shared/schemas';

// Local imports - model handlers
import { tagOpenAISdkError } from './openAISdkError';
import type { Response } from 'openai/resources/responses/responses';

interface OpenAIBackgroundResumeError {
  providerError: ProviderError;
  shouldRetainPendingResponse: boolean;
}

interface RequestIdTaggedError extends Error {
  request_id?: string;
  provider?: string;
}

type OpenAIBackgroundTerminalState = Pick<
  Response,
  'id' | 'status' | 'error' | 'incomplete_details'
>;

function setProviderHint(error: unknown, provider: string): void {
  if (error && typeof error === 'object' && !('provider' in error)) {
    (error as { provider?: string }).provider = provider;
  }
}

/** Normalize OpenAI Responses errors at the provider boundary. */
export function normalizeOpenAIResponseError(
  error: unknown,
  provider: string,
): ProviderError {
  tagOpenAISdkError(error, provider);
  setProviderHint(error, provider);
  return normalizeProviderError(error);
}

/**
 * Classify a failed background-response resume without spreading retry
 * decisions across the handler. Unknown/network-like failures keep the
 * pending response id; definitive HTTP failures clear it.
 */
export function classifyOpenAIBackgroundResumeError(
  error: unknown,
  provider: string,
): OpenAIBackgroundResumeError {
  const providerError = normalizeOpenAIResponseError(error, provider);
  const code = providerError.statusCode;
  return {
    providerError,
    shouldRetainPendingResponse:
      code === undefined || isRetryableStatusCode(code),
  };
}

/**
 * A 404 while polling a known background response means the server-side
 * response is gone. The wrapper intentionally carries no status code so the
 * retry layer treats this as a recoverable polling failure and offers manual
 * retry instead of classifying it as a non-retryable 404.
 */
export function createOpenAIBackgroundPollingError(
  responseId: string,
  cause: unknown,
  provider: string,
): Error {
  tagOpenAISdkError(cause, provider);
  const causeError = normalizeProviderError(cause);
  const pollingError: RequestIdTaggedError = new Error(
    `Background response polling failed for ${responseId}: ${causeError.message}`,
    { cause },
  );
  pollingError.provider = provider;

  if (causeError.requestId) {
    pollingError.request_id = causeError.requestId;
  }
  attachFlowAutoRetryRequired(pollingError);
  return pollingError;
}

export function createOpenAIBackgroundTerminalError(
  response: OpenAIBackgroundTerminalState,
  provider: string,
): Error {
  const fallbackStatus = response.status ?? 'unknown';
  const errorDetail =
    response.error?.message ??
    response.incomplete_details?.reason ??
    'Background response did not complete successfully.';
  const wrapped = new Error(
    `Background response ${response.id} ended with status ${fallbackStatus}: ${errorDetail}. Retrieve the latest status with client.responses.retrieve("${response.id}").`,
  ) as Error & { error?: unknown; provider?: string };
  wrapped.provider = provider;
  if (response.error) {
    wrapped.error = response.error;
  }
  attachFlowAutoRetryRequired(wrapped);
  return wrapped;
}
