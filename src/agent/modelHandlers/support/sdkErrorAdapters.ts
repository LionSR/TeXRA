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

type ErrorConstructor = abstract new (...args: any[]) => Error;

interface SdkErrorClassMapping {
  ctor: ErrorConstructor;
  kind: SdkErrorKind;
  includeStatusCode?: boolean;
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

function matchMappedSdkError(
  err: unknown,
  provider: string,
  mappings: readonly SdkErrorClassMapping[],
  apiErrorCtor?: ErrorConstructor,
): void {
  for (const { ctor, kind, includeStatusCode } of mappings) {
    if (err instanceof ctor) {
      const statusCode = includeStatusCode
        ? (err as { status?: number }).status
        : undefined;
      tagSdkError(err, provider, kind, statusCode);
      return;
    }
  }

  if (apiErrorCtor && err instanceof apiErrorCtor) {
    const statusCode = (err as { status?: number }).status;
    tagSdkError(
      err,
      provider,
      sdkErrorKindFromStatusCode(statusCode),
      statusCode,
    );
  }
}

const ANTHROPIC_SDK_ERROR_MAPPINGS: readonly SdkErrorClassMapping[] = [
  { ctor: AnthropicAPIConnectionTimeoutError, kind: 'connection_timeout' },
  { ctor: AnthropicAPIConnectionError, kind: 'connection' },
  { ctor: AnthropicAPIUserAbortError, kind: 'user_abort' },
  {
    ctor: AnthropicBadRequestError,
    kind: 'bad_request',
    includeStatusCode: true,
  },
  {
    ctor: AnthropicAuthenticationError,
    kind: 'authentication',
    includeStatusCode: true,
  },
  {
    ctor: AnthropicPermissionDeniedError,
    kind: 'permission_denied',
    includeStatusCode: true,
  },
  { ctor: AnthropicNotFoundError, kind: 'not_found', includeStatusCode: true },
  { ctor: AnthropicConflictError, kind: 'conflict', includeStatusCode: true },
  {
    ctor: AnthropicUnprocessableEntityError,
    kind: 'unprocessable_entity',
    includeStatusCode: true,
  },
  {
    ctor: AnthropicRateLimitError,
    kind: 'rate_limit',
    includeStatusCode: true,
  },
  {
    ctor: AnthropicInternalServerError,
    kind: 'internal_server',
    includeStatusCode: true,
  },
];

export function tagAnthropicSdkError(
  err: unknown,
  provider = 'anthropic',
): void {
  matchMappedSdkError(
    err,
    provider,
    ANTHROPIC_SDK_ERROR_MAPPINGS,
    AnthropicAPIError,
  );
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

const OPENAI_SDK_ERROR_MAPPINGS: readonly SdkErrorClassMapping[] = [
  { ctor: OpenAIAPIConnectionTimeoutError, kind: 'connection_timeout' },
  { ctor: OpenAIAPIConnectionError, kind: 'connection' },
  { ctor: OpenAIAPIUserAbortError, kind: 'user_abort' },
  { ctor: OpenAIBadRequestError, kind: 'bad_request', includeStatusCode: true },
  {
    ctor: OpenAIAuthenticationError,
    kind: 'authentication',
    includeStatusCode: true,
  },
  {
    ctor: OpenAIPermissionDeniedError,
    kind: 'permission_denied',
    includeStatusCode: true,
  },
  { ctor: OpenAINotFoundError, kind: 'not_found', includeStatusCode: true },
  { ctor: OpenAIConflictError, kind: 'conflict', includeStatusCode: true },
  {
    ctor: OpenAIUnprocessableEntityError,
    kind: 'unprocessable_entity',
    includeStatusCode: true,
  },
  { ctor: OpenAIRateLimitError, kind: 'rate_limit', includeStatusCode: true },
  {
    ctor: OpenAIInternalServerError,
    kind: 'internal_server',
    includeStatusCode: true,
  },
];

export function tagOpenAISdkError(err: unknown, provider = 'openai'): void {
  matchMappedSdkError(err, provider, OPENAI_SDK_ERROR_MAPPINGS, OpenAIAPIError);
}
