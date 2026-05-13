// Third-party imports
import {
  APIConnectionError as AnthropicAPIConnectionError,
  APIConnectionTimeoutError as AnthropicAPIConnectionTimeoutError,
  APIUserAbortError as AnthropicAPIUserAbortError,
  AuthenticationError as AnthropicAuthenticationError,
} from '@anthropic-ai/sdk';
import { ApiError as GoogleApiError } from '@google/genai';
import {
  APIConnectionError as OpenAIAPIConnectionError,
  APIConnectionTimeoutError as OpenAIAPIConnectionTimeoutError,
  APIUserAbortError as OpenAIAPIUserAbortError,
  AuthenticationError as OpenAIAuthenticationError,
  BadRequestError as OpenAIBadRequestError,
  RateLimitError as OpenAIRateLimitError,
} from 'openai';
import { describe, expect, it } from 'vitest';

// Local imports - agent model handlers
import {
  tagAnthropicSdkError,
  tagGoogleSdkError,
  tagOpenAISdkError,
} from '@agent/modelHandlers/support/sdkErrorAdapters';

// Local imports - common errors
import {
  attachSdkErrorMetadata,
  formatProviderHttpError,
  isUserAbort,
  sdkErrorKindFromStatusCode,
} from '@common/errors/sdkErrorUtils';

// Local imports - shared schemas
import {
  ErrorLogDataSchema,
  RetryErrorInfoSchema,
} from '@shared/schemas/errors';

class APIError extends Error {}

class BadRequestError extends APIError {}

class KimiAPIError extends APIError {}

class APIUserAbortError extends APIError {}

class UnknownSdkApiError extends APIError {}

describe('formatProviderHttpError', () => {
  it('matches generic SDK API errors through the prototype chain', () => {
    const formatted = formatProviderHttpError(
      new UnknownSdkApiError('new provider error shape'),
    );

    expect(formatted.message).toBe('new provider error shape');
    expect(formatted.userRetryable).toBe(false);
  });

  it('detects OpenAI provider errors without importing SDK classes at runtime', () => {
    const formatted = formatProviderHttpError(
      new OpenAIRateLimitError(429, {}, 'rate limited', new Headers()),
    );

    expect(formatted.provider).toBe('openai');
    expect(formatted.statusCode).toBe(429);
    expect(formatted.userRetryable).toBe(true);
  });

  it('detects Anthropic provider errors without importing SDK classes at runtime', () => {
    const formatted = formatProviderHttpError(
      new AnthropicAuthenticationError(401, {}, 'bad key', new Headers()),
    );

    expect(formatted.provider).toBe('anthropic');
    expect(formatted.statusCode).toBe(401);
    expect(formatted.userRetryable).toBe(false);
  });

  it('matches SDK abort errors through the prototype chain', () => {
    expect(isUserAbort(new APIUserAbortError('aborted'))).toBe(true);
  });

  it('preserves native SDK abort detection for packaged builds', () => {
    expect(isUserAbort(new OpenAIAPIUserAbortError())).toBe(true);
    expect(isUserAbort(new AnthropicAPIUserAbortError())).toBe(true);
  });

  it('detects AbortController DOMException aborts', () => {
    expect(isUserAbort(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  it('preserves provider context for native OpenAI HTTP errors', () => {
    const formatted = formatProviderHttpError(
      new OpenAIAuthenticationError(
        401,
        { message: 'invalid api key', type: 'invalid_request_error' },
        'invalid api key',
        new Headers({ 'x-request-id': 'req-openai' }),
      ),
    );

    expect(formatted.provider).toBe('openai');
    expect(formatted.requestId).toBe('req-openai');
    expect(formatted.statusCode).toBe(401);
  });

  it('preserves provider context for native OpenAI connection errors without response headers', () => {
    const connectionError = formatProviderHttpError(
      new OpenAIAPIConnectionError({
        message: 'network unavailable',
        cause: new Error('socket closed'),
      }),
    );
    const timeoutError = formatProviderHttpError(
      new OpenAIAPIConnectionTimeoutError({ message: 'timed out' }),
    );

    expect(connectionError.provider).toBe('openai');
    expect(connectionError.userRetryable).toBe(true);
    expect(timeoutError.provider).toBe('openai');
    expect(timeoutError.userRetryable).toBe(true);
  });

  it('preserves provider context for native Anthropic HTTP errors', () => {
    const formatted = formatProviderHttpError(
      new AnthropicAuthenticationError(
        401,
        {
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid api key' },
        },
        'invalid api key',
        new Headers({ 'request-id': 'req-anthropic' }),
      ),
    );

    expect(formatted.provider).toBe('anthropic');
    expect(formatted.requestId).toBe('req-anthropic');
    expect(formatted.statusCode).toBe(401);
  });

  it('preserves provider context for native Anthropic connection errors without response headers', () => {
    const connectionError = formatProviderHttpError(
      new AnthropicAPIConnectionError({
        message: 'network unavailable',
        cause: new Error('socket closed'),
      }),
    );
    const timeoutError = formatProviderHttpError(
      new AnthropicAPIConnectionTimeoutError({ message: 'timed out' }),
    );

    expect(connectionError.provider).toBe('anthropic');
    expect(connectionError.userRetryable).toBe(true);
    expect(timeoutError.provider).toBe('anthropic');
    expect(timeoutError.userRetryable).toBe(true);
  });

  it('prefers Anthropic request-id when response headers include both request id styles', () => {
    const err = new UnknownSdkApiError('upstream auth failed') as APIError & {
      headers: Headers;
    };
    err.headers = new Headers({
      'request-id': 'req-anthropic',
      'x-request-id': 'req-openai-compatible',
    });

    const formatted = formatProviderHttpError(err);

    expect(formatted.provider).toBe('anthropic');
    expect(formatted.requestId).toBe('req-anthropic');
  });

  it('does not infer OpenAI from generic x-request-id headers', () => {
    const err = new UnknownSdkApiError(
      'openai-compatible gateway failed',
    ) as APIError & {
      headers: Headers;
    };
    err.headers = new Headers({ 'x-request-id': 'req-compatible' });

    const formatted = formatProviderHttpError(err);

    expect(formatted.provider).toBeUndefined();
    expect(formatted.requestId).toBe('req-compatible');
  });

  it('prefers SDK class provider hints over OpenAI-compatible request headers', () => {
    const err = new KimiAPIError('moonshot auth failed') as APIError & {
      headers: Headers;
    };
    err.headers = new Headers({ 'x-request-id': 'req-kimi' });

    const formatted = formatProviderHttpError(err);

    expect(formatted.provider).toBe('moonshot');
    expect(formatted.requestId).toBe('req-kimi');
  });

  it('detects OpenAI provider from Windows pnpm stack paths', () => {
    const err = new BadRequestError('invalid request');
    err.stack = String.raw`BadRequestError: invalid request
    at request (C:\repo\node_modules\.pnpm\openai@5.0.0\node_modules\openai\core\error.mjs:12:10)`;

    const formatted = formatProviderHttpError(err);

    expect(formatted.provider).toBe('openai');
    expect(formatted.statusCode).toBe(400);
    expect(formatted.userRetryable).toBe(false);
  });

  it('detects Anthropic provider from Windows pnpm stack paths', () => {
    const err = new APIError('provider failed');
    err.stack = String.raw`APIError: provider failed
    at request (C:\repo\node_modules\.pnpm\@anthropic-ai+sdk@1.0.0\node_modules\@anthropic-ai\sdk\index.mjs:12:10)`;

    const formatted = formatProviderHttpError(err);

    expect(formatted.provider).toBe('anthropic');
    expect(formatted.userRetryable).toBe(false);
  });

  it('detects Google provider from Windows pnpm stack paths', () => {
    const err = new APIError('provider failed');
    err.stack = String.raw`APIError: provider failed
    at request (C:\repo\node_modules\.pnpm\@google+genai@1.0.0\node_modules\@google\genai\dist\index.mjs:12:10)`;

    const formatted = formatProviderHttpError(err);

    expect(formatted.provider).toBe('google');
    expect(formatted.userRetryable).toBe(false);
  });

  it('keeps SDK user aborts non-retryable while preserving provider attribution', () => {
    const err = new APIUserAbortError('aborted by user');
    err.stack = String.raw`APIUserAbortError: aborted by user
    at request (C:\repo\node_modules\.pnpm\openai@5.0.0\node_modules\openai\core\error.mjs:12:10)`;

    const formatted = formatProviderHttpError(err);

    expect(formatted.message).toBe('Request aborted');
    expect(formatted.provider).toBe('openai');
    expect(formatted.userRetryable).toBe(false);
  });

  it('formats symbol-tagged SDK errors without SDK prototype matching', () => {
    const error = new Error('provider quota');
    attachSdkErrorMetadata(error, {
      provider: 'fixture',
      kind: 'rate_limit',
      statusCode: 429,
    });

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('fixture');
    expect(formatted.statusCode).toBe(429);
    expect(formatted.message).toBe(
      'HTTP 429 Too Many Requests – provider quota',
    );
    expect(formatted.userRetryable).toBe(true);
  });

  it('formats tagged OpenAI connection errors with existing retry behavior', () => {
    const error = new OpenAIAPIConnectionTimeoutError();
    tagOpenAISdkError(error, 'openai');

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('openai');
    expect(formatted.statusCode).toBeUndefined();
    expect(formatted.message).toBe('Connection timed out');
    expect(formatted.userRetryable).toBe(true);
  });

  it('formats tagged OpenAI HTTP errors with status metadata', () => {
    const error = new OpenAIBadRequestError(
      400,
      { message: 'bad payload' },
      'bad payload',
      new Headers([['x-request-id', 'req_123']]),
    );
    tagOpenAISdkError(error, 'openai');

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('openai');
    expect(formatted.statusCode).toBe(400);
    expect(formatted.statusText).toBe('Bad Request');
    expect(formatted.message).toContain('HTTP 400 Bad Request');
    expect(formatted.message).toContain('bad payload');
    expect(formatted.requestId).toBe('req_123');
    expect(formatted.userRetryable).toBe(false);
  });

  it('classifies OpenAI insufficient_quota bodies as credential exhaustion', () => {
    const error = new Error('quota exhausted') as Error & { error: unknown };
    error.error = {
      message: 'You exceeded your current quota.',
      type: 'insufficient_quota',
      code: 'insufficient_quota',
    };
    attachSdkErrorMetadata(error, {
      provider: 'openai',
      kind: 'rate_limit',
      statusCode: 429,
    });

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('openai');
    expect(formatted.isCredentialExhausted).toBe(true);
    expect(formatted.isUpstreamCreditDepleted).toBe(true);
    expect(formatted.userRetryable).toBe(true);
  });

  it('classifies OpenAI quota messages without code as credential exhaustion', () => {
    const error = new Error('quota exhausted') as Error & { error: unknown };
    error.error = {
      message:
        'You exceeded your current quota, please check your plan and billing details.',
    };
    attachSdkErrorMetadata(error, {
      provider: 'openai',
      kind: 'rate_limit',
      statusCode: 429,
    });

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('openai');
    expect(formatted.isCredentialExhausted).toBe(true);
    expect(formatted.isUpstreamCreditDepleted).toBe(true);
    expect(formatted.userRetryable).toBe(true);
  });

  it('classifies provider-attributed OpenAI quota bodies without SDK metadata', () => {
    const error = new Error('background response failed') as Error & {
      error: unknown;
      provider: string;
    };
    error.provider = 'openai';
    error.error = {
      message: 'You exceeded your current quota.',
      type: 'insufficient_quota',
      code: 'insufficient_quota',
    };

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('openai');
    expect(formatted.statusCode).toBeUndefined();
    expect(formatted.isCredentialExhausted).toBe(true);
    expect(formatted.isUpstreamCreditDepleted).toBe(true);
    expect(formatted.userRetryable).toBe(true);
  });

  it('keeps provider-attributed background failures retryable without a status code', () => {
    const error = new Error('background response failed') as Error & {
      error: unknown;
      provider: string;
    };
    error.provider = 'openai';
    error.error = {
      message: 'The background response ended before completion.',
      type: 'server_error',
    };

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('openai');
    expect(formatted.statusCode).toBeUndefined();
    expect(formatted.isCredentialExhausted).toBeUndefined();
    expect(formatted.userRetryable).toBe(true);
  });

  it('formats tagged Anthropic user abort errors', () => {
    const error = new AnthropicAPIUserAbortError();
    tagAnthropicSdkError(error, 'anthropic');

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('anthropic');
    expect(formatted.message).toBe('Request aborted');
    expect(formatted.userRetryable).toBe(false);
  });

  it('formats tagged Google API errors with inferred kind from status', () => {
    const error = new GoogleApiError({
      message: 'quota exceeded',
      status: 429,
    });
    tagGoogleSdkError(error, 'google');

    const formatted = formatProviderHttpError(error);

    expect(formatted.provider).toBe('google');
    expect(formatted.statusCode).toBe(429);
    expect(formatted.message).toBe(
      'HTTP 429 Too Many Requests – quota exceeded',
    );
    expect(formatted.userRetryable).toBe(true);
  });

  it('derives SDK error kinds from the shared status mapping', () => {
    expect(sdkErrorKindFromStatusCode(400)).toBe('bad_request');
    expect(sdkErrorKindFromStatusCode(401)).toBe('authentication');
    expect(sdkErrorKindFromStatusCode(403)).toBe('permission_denied');
    expect(sdkErrorKindFromStatusCode(404)).toBe('not_found');
    expect(sdkErrorKindFromStatusCode(409)).toBe('conflict');
    expect(sdkErrorKindFromStatusCode(422)).toBe('unprocessable_entity');
    expect(sdkErrorKindFromStatusCode(429)).toBe('rate_limit');
    expect(sdkErrorKindFromStatusCode(500)).toBe('internal_server');
    expect(sdkErrorKindFromStatusCode(418)).toBe('api_error');
    expect(sdkErrorKindFromStatusCode(undefined)).toBe('api_error');
  });
});

describe('provider error schemas', () => {
  it('normalizes legacy retryable fields from persisted error logs', () => {
    const errorLog = ErrorLogDataSchema.parse({
      message: 'old persisted error',
      retryable: false,
      isRelayError: false,
    });
    const retryInfo = RetryErrorInfoSchema.parse({
      message: 'old retry state',
      retryable: true,
    });

    expect(errorLog.userRetryable).toBe(false);
    expect('retryable' in errorLog).toBe(false);
    expect(retryInfo.userRetryable).toBe(true);
  });
});
