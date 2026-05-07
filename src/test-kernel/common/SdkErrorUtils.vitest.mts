// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - common errors
import { formatProviderHttpError } from '@common/errors/sdkErrorUtils';

class APIError extends Error {}

class BadRequestError extends APIError {}

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
