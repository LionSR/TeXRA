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
// Third-party imports
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

// Local imports - common

// Local imports
import { getConfig } from '@utils/config';

// Google GenAI errors are still not exported as of v1.5.1 of the SDK,
// but the runtime uses the names `ClientError` and `ServerError`.
// We detect them via those names when inspecting the error object.
// The OpenAI Responses API reuses the standard OpenAI error classes so
// no additional imports are required.

/**
 * Returns a human-readable message for common SDK errors.
 * 
 * @param err - The error object from an SDK call
 * @returns A user-friendly error message. In debug mode (logger.debugMode = true),
 *          returns the full error message. Otherwise, returns a graceful message.
 * 
 * @example
 * ```typescript
 * try {
 *   await client.chat.completions.create(params);
 * } catch (err) {
 *   const message = getSdkErrorMessage(err);
 *   vscode.window.showErrorMessage(message);
 * }
 * ```
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
  // Google GenAI SDK v1.5.1+ detection - these error names are from runtime inspection
  // TODO: Update when Google exports proper error classes
  const errorName = (err as Error)?.name;
  const errorMessage = (err as Error)?.message;
  
  if (errorName === 'ClientError') {
    // Check for specific Google GenAI patterns in the message if available
    if (errorMessage?.includes('Google') || errorMessage?.includes('GenAI')) {
      return 'Google GenAI client error occurred.';
    }
    return 'Client error occurred.';
  }
  if (errorName === 'ServerError') {
    // Check for specific Google GenAI patterns in the message if available
    if (errorMessage?.includes('Google') || errorMessage?.includes('GenAI')) {
      return 'Google GenAI server error occurred.';
    }
    return 'Server error occurred.';
  }

  return 'An unexpected error occurred.';
}

/**
 * Information for guiding users on resolving SDK errors.
 */
export interface SdkErrorInfo {
  userMessage: string;
  remediation: string;
  link?: string;
  key: string;
}

/**
 * Maps common network and rate-limit errors to user guidance and status page links.
 * 
 * @param err - The error object from an SDK call
 * @returns An object containing user-friendly message, remediation guidance, 
 *          optional status page link, and a unique key for the error type.
 *          Returns null if the error doesn't match known patterns.
 * 
 * @example
 * ```typescript
 * const info = getSdkErrorInfo(err);
 * if (info) {
 *   await showInstructionWithSuppress(
 *     info.key,
 *     `${info.userMessage} ${info.remediation}`,
 *     info.link ? [{ title: 'Open Status Page', callback: () => {...} }] : undefined
 *   );
 * }
 * ```
 */
export function getSdkErrorInfo(err: unknown): SdkErrorInfo | null {
  const provider =
    err instanceof OpenAIConnectionError ||
    err instanceof OpenAIConnectionTimeoutError ||
    err instanceof OpenAIRateLimitError
      ? 'openai'
      : err instanceof AnthropicConnectionError ||
          err instanceof AnthropicConnectionTimeoutError ||
          err instanceof AnthropicRateLimitError
        ? 'anthropic'
        : undefined;

  const statusLink =
    provider === 'openai'
      ? 'https://status.openai.com/'
      : provider === 'anthropic'
        ? 'https://status.anthropic.com/'
        : undefined;

  if (
    err instanceof OpenAIConnectionError ||
    err instanceof OpenAIConnectionTimeoutError ||
    err instanceof AnthropicConnectionError ||
    err instanceof AnthropicConnectionTimeoutError ||
    (err as { status?: number; code?: number })?.status === 503 ||
    (err as { status?: number; code?: number })?.code === 503
  ) {
    return {
      userMessage: 'Network error occurred.',
      remediation: 'Check API status page.',
      link: statusLink,
      key: `${provider ?? 'api'}NetworkError`,
    };
  }

  if (
    err instanceof OpenAIRateLimitError ||
    err instanceof AnthropicRateLimitError ||
    (err as { status?: number; code?: number })?.status === 429 ||
    (err as { status?: number; code?: number })?.code === 429
  ) {
    return {
      userMessage: 'Rate limit exceeded.',
      remediation: 'Retry later.',
      key: `${provider ?? 'api'}RateLimit`,
    };
  }

  return null;
}
