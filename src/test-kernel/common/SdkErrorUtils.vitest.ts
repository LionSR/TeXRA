// Third-party imports
import {
  BadRequestError as OpenAIBadRequestError,
  RateLimitError as OpenAIRateLimitError,
} from 'openai';
import { describe, expect, it } from 'vitest';

// Local imports
import { failureInfo } from '@agent/runtime/modelAccess/failureInfo';
import { attachProviderError } from '@common/errors/sdkError/errorMetadata';
import {
  buildErrorLogData,
  getSdkErrorMessage,
  normalizeProviderError,
} from '@common/errors/sdkError/providerErrorFormat';
import type { ProviderError, RetryErrorInfo } from '@shared/schemas';
import { openaiFailure } from '../../../packages/llm/src/api/openaiError.js';
import { judgeFailure } from '../../../packages/llm/src/api/verdict.js';

/**
 * An OpenAI SDK failure as the binding raises and judges it, recorded the way
 * the run records it: the package owns every verdict on a provider's reply.
 */
const judged = (cause: unknown) =>
  failureInfo(judgeFailure(openaiFailure(cause), 'api-key'), 'openai');

describe('context-window overflow', () => {
  it('is the package verdict on third-party provider wording', () => {
    for (const message of [
      'context length exceeded',
      'Maximum context length is 128000.',
    ])
      expect(judged(new Error(message)).classification).toStrictEqual({
        kind: 'context-window',
      });
  });

  it('is not read into an unrelated error', () => {
    expect(
      judged(new Error('rate limit exceeded')).classification,
    ).toBeUndefined();
  });

  it("is the verdict on OpenAI's native error code even when the message wording is unfamiliar", () => {
    const err = new OpenAIBadRequestError(
      400,
      { code: 'context_length_exceeded', message: 'Some brand-new wording' },
      'Some brand-new wording',
      new Headers(),
    );

    expect(judged(err).classification).toStrictEqual({
      kind: 'context-window',
    });
  });

  it('is the verdict on a nested error.code (e.g. a WebSocket error wrapper) without a top-level code', () => {
    const err = new Error(
      'OpenAI WebSocket response failed: overflow',
    ) as Error & {
      error?: unknown;
    };
    err.error = { code: 'context_length_exceeded', message: 'overflow' };

    expect(judged(err).userRetryable).toBe(false);
    expect(judged(err).classification).toStrictEqual({
      kind: 'context-window',
    });
  });

  it('is not read into an unrelated native error code', () => {
    const err = new OpenAIRateLimitError(
      429,
      { code: 'rate_limit_exceeded', message: 'Too many requests' },
      'Too many requests',
      new Headers(),
    );

    expect(judged(err).classification).toBeUndefined();
  });
});

describe('attachProviderError end-to-end', () => {
  it('surfaces a cached ProviderError with statusCode and provider via normalizeProviderError', () => {
    // Simulates what happens at the flow rethrow: the RetryErrorInfo is
    // attached as-is, attachProviderError caches it, then
    // normalizeProviderError recovers it downstream.
    const retryInfo: RetryErrorInfo = {
      message: 'HTTP 429 Too Many Requests – rate limited',
      userRetryable: true,
      statusCode: 429,
      provider: 'anthropic',
    };

    const err = new Error(retryInfo.message);
    attachProviderError(err, retryInfo);

    const recovered = normalizeProviderError(err);

    expect(recovered.statusCode).toBe(429);
    expect(recovered.provider).toBe('anthropic');
    expect(recovered.userRetryable).toBe(true);
    expect(normalizeProviderError(err)).toBe(recovered);
  });

  it('recovers cached ProviderError data through wrapper causes', () => {
    const retryInfo: RetryErrorInfo = {
      message: 'HTTP 503 Service Unavailable – server overloaded',
      userRetryable: true,
      statusCode: 503,
      provider: 'anthropic',
      requestId: 'req_wrapped_503',
    };

    const cause = new Error(retryInfo.message);
    attachProviderError(cause, retryInfo);
    const wrapper = new Error('Tool-use flow failed', { cause });

    expect(getSdkErrorMessage(wrapper)).toBe(retryInfo.message);

    const logData = buildErrorLogData(wrapper, {
      operation: 'execute orchestrator',
    });

    expect(logData.statusCode).toBe(503);
    expect(logData.provider).toBe('anthropic');
    expect(logData.requestId).toBe('req_wrapped_503');
    expect(logData.rawMessage).toBe('Tool-use flow failed');
    expect(logData.operation).toBe('execute orchestrator');
    expect(normalizeProviderError(wrapper)).toBe(retryInfo);
  });

  it('ignores malformed current ProviderError metadata', () => {
    const malformed = {
      message: 'mixed provider metadata',
      userRetryable: true,
      classification: { kind: 'context-window' },
      missingApiKey: true,
    } as unknown as ProviderError;
    const err = new Error(malformed.message);
    attachProviderError(err, malformed);

    const recovered = normalizeProviderError(err);

    expect(recovered).not.toBe(malformed);
    expect(recovered.classification).toBeUndefined();
  });
});
