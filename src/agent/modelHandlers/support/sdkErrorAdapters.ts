// Third-party imports
import {
  APIConnectionError as AnthropicAPIConnectionError,
  APIConnectionTimeoutError as AnthropicAPIConnectionTimeoutError,
  APIError as AnthropicAPIError,
  APIUserAbortError as AnthropicAPIUserAbortError,
} from '@anthropic-ai/sdk';
import { ApiError as GoogleApiError } from '@google/genai';
import { OpenRouterError } from '@openrouter/sdk/models/errors';
import {
  APIConnectionError as OpenAIAPIConnectionError,
  APIConnectionTimeoutError as OpenAIAPIConnectionTimeoutError,
  APIError as OpenAIAPIError,
  APIUserAbortError as OpenAIAPIUserAbortError,
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
  for (const { ctor, kind } of mappings) {
    if (err instanceof ctor) {
      tagSdkError(err, provider, kind);
      return;
    }
  }

  if (apiErrorCtor && err instanceof apiErrorCtor) {
    const statusCode = sdkErrorStatusCode(err);
    tagSdkError(
      err,
      provider,
      sdkErrorKindFromStatusCode(statusCode),
      statusCode,
    );
  }
}

function sdkErrorStatusCode(err: unknown): number | undefined {
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status)
    ? status
    : undefined;
}

const ANTHROPIC_SDK_ERROR_MAPPINGS: readonly SdkErrorClassMapping[] = [
  { ctor: AnthropicAPIConnectionTimeoutError, kind: 'connection_timeout' },
  { ctor: AnthropicAPIConnectionError, kind: 'connection' },
  { ctor: AnthropicAPIUserAbortError, kind: 'user_abort' },
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
 * Tags OpenRouter SDK errors. The OpenRouter SDK uses a single base error class
 * (`OpenRouterError`) carrying the HTTP `statusCode`, plus subclasses per status.
 * Derive the kind from the status code so the shared metadata pipeline can
 * classify and surface them like the other providers.
 */
export function tagOpenRouterSdkError(
  err: unknown,
  provider = 'openrouter',
): void {
  if (err instanceof OpenRouterError) {
    tagSdkError(
      err,
      provider,
      sdkErrorKindFromStatusCode(err.statusCode),
      err.statusCode,
    );
  }
}

/**
 * Tags a thrown SDK error with structured metadata (provider, kind, status
 * code) so downstream formatting can classify it without importing SDK classes.
 */
export type SdkErrorTagger = (err: unknown, provider: string) => void;

/**
 * Wraps a promise so that any rejection is tagged via the supplied tagger
 * before being re-thrown. Centralizes the common `try { return await impl() }
 * catch (err) { tagSdkError(err, provider); throw err; }` pattern at SDK
 * boundaries. The tagger is invoked on every thrown error, preserving the
 * exact metadata semantics of an inline catch block.
 */
export async function withSdkErrorTag<T>(
  tagger: SdkErrorTagger,
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
];

export function tagOpenAISdkError(err: unknown, provider = 'openai'): void {
  matchMappedSdkError(err, provider, OPENAI_SDK_ERROR_MAPPINGS, OpenAIAPIError);
}
