// Local imports
import { attachManualRetryOnlyError } from '@common/errors/sdkError/errorMetadata';
import { normalizeProviderError } from '@common/errors/sdkError/providerErrorFormat';
import { isRetryableStatusCode } from '@common/errors/sdkError/sdkErrorKinds';
import type { ProviderError } from '@shared/schemas';

// Local file imports
import { tagOpenAISdkError } from '../support/sdkErrorMetadata';

// Third-party imports
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
  return pollingError;
}

/** Create a manual-retry-only error for an exhausted background response lifetime. */
export function createOpenAIBackgroundPollingTimeoutError(
  responseId: string,
  maxDurationMs: number,
  provider: string,
): Error {
  const error: RequestIdTaggedError = new Error(
    `OpenAI response ${responseId} exceeded maximum polling duration of ${maxDurationMs} ms. ` +
      `Retry explicitly to start a new response, or cancel the old job with client.responses.cancel("${responseId}").`,
  );
  error.provider = provider;
  attachManualRetryOnlyError(error);
  return error;
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
  const wrapped = wrapResponseError(
    `Background response ${response.id} ended with status ${fallbackStatus}: ${errorDetail}. Retrieve the latest status with client.responses.retrieve("${response.id}").`,
    response.error,
  ) as Error & { error?: unknown; provider?: string };
  wrapped.provider = provider;
  return wrapped;
}

/**
 * Wrap a failed Responses call in a plain `Error` while preserving the
 * structured `response.error` (a `{ code, message }` object, not just prose)
 * on the thrown error, so `isContextWindowError()` can key off `error.code`
 * instead of message wording that can drift across model generations.
 */
export function wrapResponseError(
  message: string,
  responseError: unknown,
): Error & { error?: unknown } {
  const wrapped = new Error(message) as Error & { error?: unknown };
  if (responseError) {
    wrapped.error = responseError;
  }
  return wrapped;
}
