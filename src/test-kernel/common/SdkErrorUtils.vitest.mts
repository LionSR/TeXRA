// Third-party imports
import {
  APIUserAbortError as AnthropicAPIUserAbortError,
  AuthenticationError as AnthropicAuthenticationError,
} from '@anthropic-ai/sdk';
import {
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

class KimiAPIError extends APIError {}
class UnknownSdkApiError extends APIError {}
class APIUserAbortError extends APIError {}

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

  it('prefers SDK class provider hints over OpenAI-compatible request headers', () => {
    const err = new KimiAPIError('moonshot auth failed') as APIError & {
      headers: Headers;
    };
    err.headers = new Headers({ 'x-request-id': 'req-kimi' });

    const formatted = formatProviderHttpError(err);

    expect(formatted.provider).toBe('moonshot');
    expect(formatted.requestId).toBe('req-kimi');
  });
});
