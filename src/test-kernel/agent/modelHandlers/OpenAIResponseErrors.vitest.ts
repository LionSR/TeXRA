// Third-party imports
import { NotFoundError as OpenAINotFoundError } from 'openai';
import { describe, expect, it } from 'vitest';

// Local imports - agent model handlers
import {
  classifyOpenAIBackgroundResumeError,
  createOpenAIBackgroundPollingError,
  createOpenAIBackgroundTerminalError,
  normalizeOpenAIResponseError,
} from '@agent/modelHandlers/openAIResponseErrors';

// Local imports - common errors
import { formatProviderHttpError } from '@common/errors/sdkErrorUtils';

describe('OpenAI Responses error normalization', () => {
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
    expect(providerError.isCredentialExhausted).toBe(true);
    expect(providerError.isUpstreamCreditDepleted).toBe(true);
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
    const error = new OpenAINotFoundError(
      404,
      { message: 'response not found' },
      'response not found',
      new Headers([['x-request-id', 'req_missing']]),
    );

    const result = classifyOpenAIBackgroundResumeError(error, 'openai');

    expect(result.shouldRetainPendingResponse).toBe(false);
    expect(result.providerError.statusCode).toBe(404);
    expect(result.providerError.requestId).toBe('req_missing');
  });

  it('wraps vanished polling responses as retryable provider failures', () => {
    const cause = new OpenAINotFoundError(
      404,
      { message: 'response not found' },
      'response not found',
      new Headers([['x-request-id', 'req_poll']]),
    );
    const wrapped = createOpenAIBackgroundPollingError(
      'resp_123',
      cause,
      'openai',
    );

    const providerError = formatProviderHttpError(wrapped);

    expect(providerError.statusCode).toBeUndefined();
    expect(providerError.requestId).toBe('req_poll');
    expect(providerError.userRetryable).toBe(true);
    expect(providerError.message).toContain('resp_123');
  });

  it('keeps terminal background statuses retryable without HTTP metadata', () => {
    const wrapped = createOpenAIBackgroundTerminalError(
      {
        id: 'resp_failed',
        status: 'failed',
        error: {
          message: 'The background response ended before completion.',
        },
      },
      'openai',
    );

    const providerError = formatProviderHttpError(wrapped);

    expect(providerError.provider).toBe('openai');
    expect(providerError.statusCode).toBeUndefined();
    expect(providerError.userRetryable).toBe(true);
    expect(providerError.message).toContain('resp_failed');
  });
});
