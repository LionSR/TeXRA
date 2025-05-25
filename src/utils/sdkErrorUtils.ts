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

// Google GenAI errors are not formally exported, but the SDK assigns
// the names 'ClientError' and 'ServerError'. We detect them via name.

/**
 * Returns a human-readable message for common SDK errors.
 */
export function getSdkErrorMessage(err: unknown): string {
  if (
    err instanceof OpenAIRateLimitError ||
    err instanceof AnthropicRateLimitError
  ) {
    return 'Rate limit exceeded.';
  }
  if (
    err instanceof OpenAIConnectionTimeoutError ||
    err instanceof AnthropicConnectionTimeoutError
  ) {
    return 'Connection timed out.';
  }
  if (
    err instanceof OpenAIConnectionError ||
    err instanceof AnthropicConnectionError
  ) {
    return 'Connection error.';
  }
  if (
    err instanceof OpenAIAuthenticationError ||
    err instanceof AnthropicAuthenticationError
  ) {
    return 'Authentication failed.';
  }
  if (
    err instanceof OpenAIPermissionDeniedError ||
    err instanceof AnthropicPermissionDeniedError
  ) {
    return 'Permission denied.';
  }
  if (err instanceof OpenAIAPIError || err instanceof AnthropicAPIError) {
    const status = err.status ? `${err.status} ` : '';
    return `${status}${err.message}`.trim();
  }
  if ((err as Error)?.name === 'ClientError') {
    return `Google GenAI client error: ${(err as Error).message}`;
  }
  if ((err as Error)?.name === 'ServerError') {
    return `Google GenAI server error: ${(err as Error).message}`;
  }

  return err instanceof Error ? err.message : String(err);
}

/**
 * Formats a provider error with a custom prefix.
 */
export function formatProviderError(prefix: string, err: unknown): string {
  return `${prefix}: ${getSdkErrorMessage(err)}`;
}
