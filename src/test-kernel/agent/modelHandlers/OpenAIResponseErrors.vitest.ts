// Third-party imports
import { NotFoundError as OpenAINotFoundError } from 'openai';
import { describe, expect, it } from 'vitest';

// Local imports
import {
  classifyOpenAIBackgroundResumeError,
  createOpenAIBackgroundPollingError,
  createOpenAIBackgroundPollingTimeoutError,
  createOpenAIBackgroundTerminalError,
  normalizeOpenAIResponseError,
} from '@agent/modelHandlers/openai/openAIResponseErrors';
import { attachContextWindowError } from '@common/errors/sdkError/errorMetadata';
import {
  formatProviderHttpError,
  isProviderErrorAutoRetryable,
  normalizeProviderError,
} from '@common/errors/sdkError/providerErrorFormat';

describe('OpenAI Responses error normalization', () => {
  function notFoundError(requestId: string): OpenAINotFoundError {
    return new OpenAINotFoundError(
      404,
      { message: 'response not found' },
      'response not found',
      new Headers([['x-request-id', requestId]]),
    );
  }

  it('normalizes provider errors at the OpenAI Responses boundary', () => {
    const error = new Error('background response failed') as Error & {
      error: unknown;
      provider?: string;
    };
    error.error = {
      message: 'You exceeded your current quota.',
      type: 'insufficient_quota',
      code: 'insufficient_quota',
    };

    const providerError = normalizeOpenAIResponseError(error, 'openai');

    expect(providerError.provider).toBe('openai');
    expect(providerError.exhaustionReason).toBe('upstream-credit');
    expect(providerError.userRetryable).toBe(true);
  });

  it('retains pending background responses for transient resume failures', () => {
    const error = new Error('socket closed');

    const result = classifyOpenAIBackgroundResumeError(error, 'openai');

    expect(result.shouldRetainPendingResponse).toBe(true);
    expect(result.providerError.statusCode).toBeUndefined();
    expect(result.providerError.userRetryable).toBe(true);
  });

  it('clears pending background responses for definitive resume failures', () => {
    const result = classifyOpenAIBackgroundResumeError(
      notFoundError('req_missing'),
      'openai',
    );

    expect(result.shouldRetainPendingResponse).toBe(false);
    expect(result.providerError.statusCode).toBe(404);
    expect(result.providerError.requestId).toBe('req_missing');
  });

  it('wraps vanished polling responses as retryable provider failures', () => {
    const wrapped = createOpenAIBackgroundPollingError(
      'resp_123',
      notFoundError('req_poll'),
      'openai',
    );

    const providerError = formatProviderHttpError(wrapped);

    expect(providerError.statusCode).toBeUndefined();
    expect(providerError.requestId).toBe('req_poll');
    expect(providerError.userRetryable).toBe(true);
    expect(providerError.message).toContain('resp_123');

    const normalized = normalizeProviderError(wrapped);
    expect(normalized.statusCode).toBeUndefined();
    expect(normalized.requestId).toBe('req_poll');
    expect(normalized.userRetryable).toBe(true);
  });

  it('requires an explicit retry after the polling lifetime expires', () => {
    const error = createOpenAIBackgroundPollingTimeoutError(
      'resp_expired',
      10_800_000,
      'openai',
    );

    const providerError = normalizeProviderError(error);

    expect(providerError.userRetryable).toBe(true);
    expect(isProviderErrorAutoRetryable(error)).toBe(false);
    expect(providerError.provider).toBe('openai');
    expect(providerError.message).toContain('resp_expired');
    expect(providerError.message).toContain('Retry explicitly');
  });

  it('classifies internally tagged context-window overflows as non-retryable', () => {
    // The pre-flight guard's throw has no status code; without an explicit
    // context-window branch the classifier would fall to the "no status code
    // → retry for safety" default — but retrying resends the same oversized
    // payload and deterministically fails again.
    const error = new Error(
      'Token count of message exceeds context window: 2331803 > 1050000',
    );
    attachContextWindowError(error);

    const providerError = formatProviderHttpError(error);

    expect(providerError.userRetryable).toBe(false);
    expect(providerError.message).toContain('2331803 > 1050000');

    const normalized = normalizeProviderError(error);
    expect(normalized.userRetryable).toBe(false);
  });

  it('classifies provider-worded context-window errors as non-retryable', () => {
    const error = new Error(
      "This model's maximum context length is 1050000 tokens.",
    );

    const providerError = formatProviderHttpError(error);

    expect(providerError.userRetryable).toBe(false);
  });

  it('keeps body-classified rate limits retryable when their message mentions context', () => {
    const error = Object.assign(
      new Error("This model's maximum context length is temporarily limited."),
      {
        error: {
          type: 'rate_limit_error',
          message:
            "This model's maximum context length is temporarily limited.",
        },
      },
    );

    const providerError = formatProviderHttpError(error);

    expect(providerError.statusCode).toBe(429);
    expect(providerError.userRetryable).toBe(true);
  });

  it('infers retryable server status for terminal background responses', () => {
    const wrapped = createOpenAIBackgroundTerminalError(
      {
        id: 'resp_failed',
        status: 'failed',
        error: {
          code: 'server_error',
          message: 'The background response ended before completion.',
        },
        incomplete_details: null,
      },
      'openai',
    );

    const providerError = formatProviderHttpError(wrapped);

    expect(providerError.provider).toBe('openai');
    expect(providerError.statusCode).toBe(500);
    expect(providerError.userRetryable).toBe(true);
    expect(providerError.message).toContain('resp_failed');
  });
});
