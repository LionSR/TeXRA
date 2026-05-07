// Third-party imports
import {
  APIConnectionError as AnthropicAPIConnectionError,
  APIConnectionTimeoutError as AnthropicAPIConnectionTimeoutError,
  APIUserAbortError as AnthropicAPIUserAbortError,
  AuthenticationError as AnthropicAuthenticationError,
} from '@anthropic-ai/sdk';
import {
  APIConnectionError as OpenAIAPIConnectionError,
  APIConnectionTimeoutError as OpenAIAPIConnectionTimeoutError,
  APIUserAbortError as OpenAIAPIUserAbortError,
  AuthenticationError as OpenAIAuthenticationError,
} from 'openai';
import { describe, expect, it } from 'vitest';

// Local imports - common errors
import {
  formatProviderHttpError,
  isUserAbort,
} from '@common/errors/sdkErrorUtils';

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
    expect(formatted.retryable).toBe(false);
  });

  it('matches SDK abort errors through the prototype chain', () => {
    expect(isUserAbort(new APIUserAbortError('aborted'))).toBe(true);
  });

  it('preserves native SDK abort detection for packaged builds', () => {
    expect(isUserAbort(new OpenAIAPIUserAbortError())).toBe(true);
    expect(isUserAbort(new AnthropicAPIUserAbortError())).toBe(true);
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
    expect(connectionError.retryable).toBe(true);
    expect(timeoutError.provider).toBe('openai');
    expect(timeoutError.retryable).toBe(true);
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
    expect(connectionError.retryable).toBe(true);
    expect(timeoutError.provider).toBe('anthropic');
    expect(timeoutError.retryable).toBe(true);
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
    expect(formatted.retryable).toBe(false);
  });

  it('detects Anthropic provider from Windows pnpm stack paths', () => {
    const err = new APIError('provider failed');
    err.stack = String.raw`APIError: provider failed
    at request (C:\repo\node_modules\.pnpm\@anthropic-ai+sdk@1.0.0\node_modules\@anthropic-ai\sdk\index.mjs:12:10)`;

    const formatted = formatProviderHttpError(err);

    expect(formatted.provider).toBe('anthropic');
    expect(formatted.retryable).toBe(false);
  });

  it('detects Google provider from Windows pnpm stack paths', () => {
    const err = new APIError('provider failed');
    err.stack = String.raw`APIError: provider failed
    at request (C:\repo\node_modules\.pnpm\@google+genai@1.0.0\node_modules\@google\genai\dist\index.mjs:12:10)`;

    const formatted = formatProviderHttpError(err);

    expect(formatted.provider).toBe('google');
    expect(formatted.retryable).toBe(false);
  });

  it('keeps SDK user aborts non-retryable while preserving provider attribution', () => {
    const err = new APIUserAbortError('aborted by user');
    err.stack = String.raw`APIUserAbortError: aborted by user
    at request (C:\repo\node_modules\.pnpm\openai@5.0.0\node_modules\openai\core\error.mjs:12:10)`;

    const formatted = formatProviderHttpError(err);

    expect(formatted.message).toBe('Request aborted');
    expect(formatted.provider).toBe('openai');
    expect(formatted.retryable).toBe(false);
  });
});
