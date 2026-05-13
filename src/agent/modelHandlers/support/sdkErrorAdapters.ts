// Third-party imports
import {
  APIConnectionError as AnthropicAPIConnectionError,
  APIConnectionTimeoutError as AnthropicAPIConnectionTimeoutError,
  APIError as AnthropicAPIError,
  APIUserAbortError as AnthropicAPIUserAbortError,
  AuthenticationError as AnthropicAuthenticationError,
  BadRequestError as AnthropicBadRequestError,
  ConflictError as AnthropicConflictError,
  InternalServerError as AnthropicInternalServerError,
  NotFoundError as AnthropicNotFoundError,
  PermissionDeniedError as AnthropicPermissionDeniedError,
  RateLimitError as AnthropicRateLimitError,
  UnprocessableEntityError as AnthropicUnprocessableEntityError,
} from '@anthropic-ai/sdk';
import { ApiError as GoogleApiError } from '@google/genai';
import {
  APIConnectionError as OpenAIAPIConnectionError,
  APIConnectionTimeoutError as OpenAIAPIConnectionTimeoutError,
  APIError as OpenAIAPIError,
  APIUserAbortError as OpenAIAPIUserAbortError,
  AuthenticationError as OpenAIAuthenticationError,
  BadRequestError as OpenAIBadRequestError,
  ConflictError as OpenAIConflictError,
  InternalServerError as OpenAIInternalServerError,
  NotFoundError as OpenAINotFoundError,
  PermissionDeniedError as OpenAIPermissionDeniedError,
  RateLimitError as OpenAIRateLimitError,
  UnprocessableEntityError as OpenAIUnprocessableEntityError,
} from 'openai';

// Local imports - common errors
import {
  attachSdkErrorMetadata,
  sdkErrorKindFromStatusCode,
  type SdkErrorKind,
} from '@common/errors/sdkErrorUtils';

function tagSdkError(
  err: unknown,
  provider: string,
  kind: SdkErrorKind,
  statusCode?: number,
): void {
  attachSdkErrorMetadata(err, {
    provider,
    kind,
    ...(statusCode !== undefined && { statusCode }),
  });
}

export function tagAnthropicSdkError(
  err: unknown,
  provider = 'anthropic',
): void {
  if (err instanceof AnthropicAPIConnectionTimeoutError) {
    tagSdkError(err, provider, 'connection_timeout');
  } else if (err instanceof AnthropicAPIConnectionError) {
    tagSdkError(err, provider, 'connection');
  } else if (err instanceof AnthropicAPIUserAbortError) {
    tagSdkError(err, provider, 'user_abort');
  } else if (err instanceof AnthropicBadRequestError) {
    tagSdkError(err, provider, 'bad_request', err.status);
  } else if (err instanceof AnthropicAuthenticationError) {
    tagSdkError(err, provider, 'authentication', err.status);
  } else if (err instanceof AnthropicPermissionDeniedError) {
    tagSdkError(err, provider, 'permission_denied', err.status);
  } else if (err instanceof AnthropicNotFoundError) {
    tagSdkError(err, provider, 'not_found', err.status);
  } else if (err instanceof AnthropicConflictError) {
    tagSdkError(err, provider, 'conflict', err.status);
  } else if (err instanceof AnthropicUnprocessableEntityError) {
    tagSdkError(err, provider, 'unprocessable_entity', err.status);
  } else if (err instanceof AnthropicRateLimitError) {
    tagSdkError(err, provider, 'rate_limit', err.status);
  } else if (err instanceof AnthropicInternalServerError) {
    tagSdkError(err, provider, 'internal_server', err.status);
  } else if (err instanceof AnthropicAPIError) {
    tagSdkError(
      err,
      provider,
      sdkErrorKindFromStatusCode(err.status),
      err.status,
    );
  }
}

export function tagGoogleSdkError(err: unknown, provider = 'google'): void {
  if (err instanceof GoogleApiError) {
    tagSdkError(
      err,
      provider,
      sdkErrorKindFromStatusCode(err.status),
      err.status,
    );
  }
}

/**
 * Wraps a promise so that any rejection is tagged via the supplied tagger
 * before being re-thrown. Centralizes the common `try { return await impl() }
 * catch (err) { tagSdkError(err, provider); throw err; }` pattern at SDK
 * boundaries. The tagger is invoked on every thrown error, preserving the
 * exact metadata semantics of an inline catch block.
 */
export async function withSdkErrorTag<T>(
  tagger: (err: unknown, provider: string) => void,
  provider: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    tagger(err, provider);
    throw err;
  }
}

export function tagOpenAISdkError(err: unknown, provider = 'openai'): void {
  if (err instanceof OpenAIAPIConnectionTimeoutError) {
    tagSdkError(err, provider, 'connection_timeout');
  } else if (err instanceof OpenAIAPIConnectionError) {
    tagSdkError(err, provider, 'connection');
  } else if (err instanceof OpenAIAPIUserAbortError) {
    tagSdkError(err, provider, 'user_abort');
  } else if (err instanceof OpenAIBadRequestError) {
    tagSdkError(err, provider, 'bad_request', err.status);
  } else if (err instanceof OpenAIAuthenticationError) {
    tagSdkError(err, provider, 'authentication', err.status);
  } else if (err instanceof OpenAIPermissionDeniedError) {
    tagSdkError(err, provider, 'permission_denied', err.status);
  } else if (err instanceof OpenAINotFoundError) {
    tagSdkError(err, provider, 'not_found', err.status);
  } else if (err instanceof OpenAIConflictError) {
    tagSdkError(err, provider, 'conflict', err.status);
  } else if (err instanceof OpenAIUnprocessableEntityError) {
    tagSdkError(err, provider, 'unprocessable_entity', err.status);
  } else if (err instanceof OpenAIRateLimitError) {
    tagSdkError(err, provider, 'rate_limit', err.status);
  } else if (err instanceof OpenAIInternalServerError) {
    tagSdkError(err, provider, 'internal_server', err.status);
  } else if (err instanceof OpenAIAPIError) {
    tagSdkError(
      err,
      provider,
      sdkErrorKindFromStatusCode(err.status),
      err.status,
    );
  }
}
