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
  type SdkErrorKind,
} from '@common/errors/sdkErrorUtils';

function sdkKindFromStatus(statusCode: number | undefined): SdkErrorKind {
  switch (statusCode) {
    case 400:
      return 'bad_request';
    case 401:
      return 'authentication';
    case 403:
      return 'permission_denied';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 422:
      return 'unprocessable_entity';
    case 429:
      return 'rate_limit';
    case 500:
      return 'internal_server';
    default:
      return 'api_error';
  }
}

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
    tagSdkError(err, provider, sdkKindFromStatus(err.status), err.status);
  }
}

export function tagGoogleSdkError(err: unknown, provider = 'google'): void {
  if (err instanceof GoogleApiError) {
    tagSdkError(err, provider, sdkKindFromStatus(err.status), err.status);
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
    tagSdkError(err, provider, sdkKindFromStatus(err.status), err.status);
  }
}
