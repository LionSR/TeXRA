// Third-party imports
import {
  APIConnectionError as OpenAIConnectionError,
  APIConnectionTimeoutError as OpenAIConnectionTimeoutError,
  APIError as OpenAIAPIError,
  AuthenticationError as OpenAIAuthenticationError,
  PermissionDeniedError as OpenAIPermissionDeniedError,
  RateLimitError as OpenAIRateLimitError,
} from 'openai';
import {
  APIConnectionError as AnthropicConnectionError,
  APIConnectionTimeoutError as AnthropicConnectionTimeoutError,
  APIError as AnthropicAPIError,
  AuthenticationError as AnthropicAuthenticationError,
  PermissionDeniedError as AnthropicPermissionDeniedError,
  RateLimitError as AnthropicRateLimitError,
} from '@anthropic-ai/sdk';

// Local imports
import { getConfig } from './configUtils';

// Google GenAI errors are not formally exported, but the SDK assigns
// the names 'ClientError' and 'ServerError'. We detect them via name.

/**
 * Returns a human-readable message for common SDK errors.
 * In debug mode (logger.verboseOutput = true), returns the full error message.
 * Otherwise, returns a graceful, user-friendly message.
 */
export function getSdkErrorMessage(err: unknown): string {
  const isDebugMode = getConfig<boolean>('logger.verboseOutput', false);
  
  // In debug mode, always show the full error message
  if (isDebugMode) {
    return err instanceof Error ? err.message : String(err);
  }

  // In normal mode, provide graceful error messages
  const errorMapping: [Function, string][] = [
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
  ];

  for (const [ErrorClass, message] of errorMapping) {
    if (err instanceof ErrorClass) {
      return message;
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

/**
 * Formats a provider error with a custom prefix.
 */
export function formatProviderError(prefix: string, err: unknown): string {
  return `${prefix}: ${getSdkErrorMessage(err)}`;
}
