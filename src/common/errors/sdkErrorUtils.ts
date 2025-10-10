// Third-party imports
import {
  APIConnectionError as AnthropicConnectionError,
  APIConnectionTimeoutError as AnthropicConnectionTimeoutError,
  APIError as AnthropicAPIError,
  AuthenticationError as AnthropicAuthenticationError,
  PermissionDeniedError as AnthropicPermissionDeniedError,
  RateLimitError as AnthropicRateLimitError,
  BadRequestError as AnthropicBadRequestError,
  NotFoundError as AnthropicNotFoundError,
  ConflictError as AnthropicConflictError,
  UnprocessableEntityError as AnthropicUnprocessableEntityError,
  InternalServerError as AnthropicInternalServerError,
  APIUserAbortError as AnthropicUserAbortError,
} from '@anthropic-ai/sdk';
import {
  APIConnectionError as OpenAIConnectionError,
  APIConnectionTimeoutError as OpenAIConnectionTimeoutError,
  APIError as OpenAIAPIError,
  AuthenticationError as OpenAIAuthenticationError,
  PermissionDeniedError as OpenAIPermissionDeniedError,
  RateLimitError as OpenAIRateLimitError,
  BadRequestError as OpenAIBadRequestError,
  NotFoundError as OpenAINotFoundError,
  ConflictError as OpenAIConflictError,
  UnprocessableEntityError as OpenAIUnprocessableEntityError,
  InternalServerError as OpenAIInternalServerError,
  APIUserAbortError as OpenAIUserAbortError,
} from 'openai';

// Local imports - configuration
import { getConfig } from '@utils/config';

// Google GenAI errors are still not exported as of v1.5.1 of the SDK,
// but the runtime uses the names `ClientError` and `ServerError`.
// We detect them via those names when inspecting the error object.
// The OpenAI Responses API reuses the standard OpenAI error classes so
// no additional imports are required.

/**
 * Returns a human-readable message for common SDK errors.
 * In debug mode (logger.debugMode = true), returns the full error message.
 * Otherwise, returns a graceful, user-friendly message.
 */
export function getSdkErrorMessage(err: unknown): string {
  const isDebugMode = getConfig<boolean>('logger.debugMode', false);

  // In debug mode, always show the full error message
  if (isDebugMode) {
    return err instanceof Error ? err.message : String(err);
  }

  // In normal mode, provide graceful error messages
  const errorMapping: [new (...args: any[]) => any, string][] = [
    [OpenAIRateLimitError, 'Rate limit exceeded.'],
    [AnthropicRateLimitError, 'Rate limit exceeded.'],
    [OpenAIConnectionTimeoutError, 'Connection timed out.'],
    [AnthropicConnectionTimeoutError, 'Connection timed out.'],
    [OpenAIConnectionError, 'Connection error.'],
    [AnthropicConnectionError, 'Connection error.'],
    [OpenAIAuthenticationError, 'Authentication failed.'],
    [AnthropicAuthenticationError, 'Authentication failed.'],
    [OpenAIPermissionDeniedError, 'Permission denied.'],
    [AnthropicPermissionDeniedError, 'Permission denied.'],
    [OpenAIBadRequestError, 'Bad request.'],
    [AnthropicBadRequestError, 'Bad request.'],
    [OpenAINotFoundError, 'Resource not found.'],
    [AnthropicNotFoundError, 'Resource not found.'],
    [OpenAIConflictError, 'Conflict error.'],
    [AnthropicConflictError, 'Conflict error.'],
    [OpenAIUnprocessableEntityError, 'Unprocessable entity.'],
    [AnthropicUnprocessableEntityError, 'Unprocessable entity.'],
    [OpenAIInternalServerError, 'Internal server error.'],
    [AnthropicInternalServerError, 'Internal server error.'],
    [OpenAIUserAbortError, 'Request aborted.'],
    [AnthropicUserAbortError, 'Request aborted.'],
  ];

  for (const [ErrorClass, message] of errorMapping) {
    if (err instanceof ErrorClass) {
      return message;
    }
  }
  const maybeCode = err as { code?: number; status?: number } | undefined;
  const code = maybeCode?.code ?? maybeCode?.status;
  if (typeof code === 'number') {
    const codeMapping: Record<number, string> = {
      400: 'Bad request.',
      401: 'Authentication failed.',
      403: 'Permission denied.',
      404: 'Resource not found.',
      409: 'Conflict error.',
      422: 'Unprocessable entity.',
      429: 'Rate limit exceeded.',
      500: 'Internal server error.',
      503: 'Service unavailable.',
      504: 'Deadline exceeded.',
    };
    const mapped = codeMapping[code];
    if (mapped) {
      return mapped;
    }
  }
  if (err instanceof OpenAIAPIError || err instanceof AnthropicAPIError) {
    return 'API error occurred.';
  }
  if ((err as Error)?.name === 'ClientError') {
    return 'Google GenAI client error occurred.';
  }
  if ((err as Error)?.name === 'ServerError') {
    return 'Google GenAI server error occurred.';
  }

  return 'An unexpected error occurred.';
}
