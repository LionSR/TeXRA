// Third-party imports
import {
  APIConnectionError as AnthropicAPIConnectionError,
  APIConnectionTimeoutError as AnthropicAPIConnectionTimeoutError,
  APIError as AnthropicAPIError,
  APIUserAbortError as AnthropicAPIUserAbortError,
} from '@anthropic-ai/sdk';
import { ApiError as GoogleApiError } from '@google/genai';
import {
  ConnectionError as OpenRouterConnectionError,
  OpenRouterError,
  RequestTimeoutError as OpenRouterRequestTimeoutError,
} from '@openrouter/sdk/models/errors';
import {
  APIConnectionError as OpenAIAPIConnectionError,
  APIConnectionTimeoutError as OpenAIAPIConnectionTimeoutError,
  APIError as OpenAIAPIError,
  APIUserAbortError as OpenAIAPIUserAbortError,
} from 'openai';

// Local imports - common errors
import { detectStatusCode } from '@common/errors/sdkError/errorInspection';
import { attachSdkErrorMetadata } from '@common/errors/sdkError/errorMetadata';
import {
  sdkErrorKindFromStatusCode,
  type SdkErrorKind,
} from '@common/errors/sdkError/sdkErrorKinds';

type ErrorConstructor = abstract new (...args: any[]) => Error;

interface SdkErrorClassMapping {
  ctor: ErrorConstructor;
  kind: SdkErrorKind;
}

function tagSdkError(
  err: unknown,
  provider: string,
  kind: SdkErrorKind,
  statusCode?: number,
): void {
  attachSdkErrorMetadata(err, { provider, kind, statusCode });
}

function matchMappedSdkError(
  err: unknown,
  provider: string,
  mappings: readonly SdkErrorClassMapping[],
  apiErrorCtor?: ErrorConstructor,
): void {
  for (const { ctor, kind } of mappings) {
    if (err instanceof ctor) {
      tagSdkError(err, provider, kind);
      return;
    }
  }

  if (apiErrorCtor && err instanceof apiErrorCtor) {
    const statusCode = detectStatusCode(err);
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
];

export function tagAnthropicSdkError(err: unknown, provider: string): void {
  matchMappedSdkError(
    err,
    provider,
    ANTHROPIC_SDK_ERROR_MAPPINGS,
    AnthropicAPIError,
  );
}

/**
 * Tags Google GenAI SDK errors. `GoogleApiError` carries the HTTP status, which
 * the shared metadata pipeline reads (via `detectStatusCode`) to derive the kind
 * and surface it like the other providers.
 */
export function tagGoogleSdkError(err: unknown, provider: string): void {
  matchMappedSdkError(err, provider, [], GoogleApiError);
}

const OPENAI_SDK_ERROR_MAPPINGS: readonly SdkErrorClassMapping[] = [
  { ctor: OpenAIAPIConnectionTimeoutError, kind: 'connection_timeout' },
  { ctor: OpenAIAPIConnectionError, kind: 'connection' },
  { ctor: OpenAIAPIUserAbortError, kind: 'user_abort' },
];

export function tagOpenAISdkError(err: unknown, provider: string): void {
  matchMappedSdkError(err, provider, OPENAI_SDK_ERROR_MAPPINGS, OpenAIAPIError);
}

/**
 * Tags OpenRouter SDK errors. Transport failures get explicit connection
 * kinds from the SDK's own HTTPClientError subclasses — without these the
 * route classifier would fall back to name-regex sniffing, since the SDK's
 * `ConnectionError` doesn't match the exact class names the legacy matcher
 * knows. API errors use the single base class (`OpenRouterError`) carrying
 * the HTTP `statusCode`; the shared metadata pipeline reads that status (via
 * `detectStatusCode`) to derive the kind so it is classified and surfaced
 * like the other providers.
 */
export function tagOpenRouterSdkError(err: unknown, provider: string): void {
  matchMappedSdkError(
    err,
    provider,
    [
      { ctor: OpenRouterRequestTimeoutError, kind: 'connection_timeout' },
      { ctor: OpenRouterConnectionError, kind: 'connection' },
    ],
    OpenRouterError,
  );
}
